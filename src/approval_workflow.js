import { createApprovalRequest } from './models.js';
import { evaluateAuthorization } from './decision_engine.js';
import { AUDIT_EVENT_TYPES } from './audit_logger.js';

export const APPROVAL_STATES = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED'
};

export class ApprovalWorkflowManager {
  constructor({ gateway, storage } = {}) {
    this.gateway = gateway;
    this.storage = storage || gateway?.storage || null;
    this.approvals = new Map();
  }

  createApproval({ paymentRequest, policy, riskLevel, reason, expiresInMinutes = 60 }) {
    const approvalObj = createApprovalRequest({
      requestId: paymentRequest.requestId,
      amount: paymentRequest.amount.value,
      merchant: paymentRequest.merchant.name,
      riskLevel,
      reason,
      expiresInMinutes
    });

    const record = {
      approvalRequest: approvalObj,
      paymentRequest,
      policySnapshot: { ...policy }
    };

    this.approvals.set(approvalObj.approvalId, record);

    if (this.storage) {
      this._lastPersistPromise = this.storage.createApproval(record).catch(err => {
        console.error('[PayGuard Approvals] Warning: Failed to persist approval to storage:', err.message);
      });
    }

    if (this.gateway?.auditLogger) {
      this.gateway.auditLogger.logEvent({
        eventType: AUDIT_EVENT_TYPES.APPROVAL_REQUIRED,
        requestId: paymentRequest.requestId,
        agentId: paymentRequest.agentId,
        decision: 'REQUIRE_APPROVAL',
        reasonCodes: ['POLICY_APPROVAL_REQUIRED'],
        explanation: `Human approval requested: ${reason}`,
        paypalCalled: false,
        details: { approvalId: approvalObj.approvalId, riskLevel }
      });
    }

    return approvalObj;
  }

  async flushPendingApprovals() {
    if (this._lastPersistPromise) {
      await this._lastPersistPromise;
    }
  }

  getApproval(approvalId) {
    const record = this.approvals.get(String(approvalId));
    if (!record) return null;

    if (record.approvalRequest.status === APPROVAL_STATES.PENDING) {
      if (new Date() > new Date(record.approvalRequest.expiresAt)) {
        record.approvalRequest.status = APPROVAL_STATES.EXPIRED;
        if (this.gateway?.auditLogger) {
          this.gateway.auditLogger.logEvent({
            eventType: AUDIT_EVENT_TYPES.APPROVAL_EXPIRED,
            requestId: record.paymentRequest?.requestId,
            agentId: record.paymentRequest?.agentId,
            decision: 'EXPIRED',
            explanation: `Approval "${approvalId}" expired before human resolution.`,
            paypalCalled: false,
            details: { approvalId }
          });
        }
      }
    }

    return record.approvalRequest;
  }

  async getApprovalAsync(approvalId) {
    let record = this.approvals.get(String(approvalId));
    if (!record && this.storage) {
      const stored = await this.storage.getApproval(approvalId);
      if (stored) {
        record = {
          approvalRequest: {
            approvalId: stored.approvalId,
            requestId: stored.requestId,
            status: stored.status,
            riskLevel: stored.riskLevel,
            amount: stored.amount,
            merchant: stored.merchant,
            reason: stored.reason,
            expiresAt: stored.expiresAt
          },
          paymentRequest: stored.paymentRequest,
          policySnapshot: stored.policySnapshot
        };
        this.approvals.set(String(approvalId), record);
      }
    }
    return this.getApproval(approvalId);
  }

  getAllApprovals() {
    for (const id of this.approvals.keys()) {
      this.getApproval(id);
    }
    return Array.from(this.approvals.values()).map(r => r.approvalRequest);
  }

  async getAllApprovalsAsync() {
    if (this.storage) {
      try {
        const stored = await this.storage.getAllApprovals();
        if (Array.isArray(stored) && stored.length > 0) {
          return stored.map(s => s.approvalRequest || s);
        }
      } catch (err) {
        console.error('[PayGuard Approvals] Warning: Error fetching approvals from storage:', err.message);
      }
    }
    return this.getAllApprovals();
  }

  async approveRequest(approvalId, currentPolicy = null) {
    let record = this.approvals.get(String(approvalId));
    if (!record && this.storage) {
      await this.getApproval(approvalId);
      record = this.approvals.get(String(approvalId));
    }

    if (!record) {
      throw new Error(`Approval "${approvalId}" not found.`);
    }

    const { approvalRequest, paymentRequest, policySnapshot } = record;

    if (approvalRequest.status === APPROVAL_STATES.EXPIRED || new Date() > new Date(approvalRequest.expiresAt)) {
      approvalRequest.status = APPROVAL_STATES.EXPIRED;
      throw new Error(`Cannot approve: Approval "${approvalId}" has EXPIRED.`);
    }

    if (approvalRequest.status !== APPROVAL_STATES.PENDING) {
      throw new Error(`Cannot approve: Approval "${approvalId}" is already ${approvalRequest.status}.`);
    }

    // Atomic resolution in database to prevent double approvals or race conditions
    if (this.storage) {
      const atomicResolved = await this.storage.resolveApproval(approvalId, {
        status: APPROVAL_STATES.APPROVED,
        resolutionNote: 'Human operator approved'
      });
      if (!atomicResolved) {
        throw new Error(`Cannot approve: Approval "${approvalId}" is already resolved or not found.`);
      }
    }

    if (this.gateway.ledger.hasSeen(paymentRequest.requestId)) {
      const pastRecord = this.gateway.ledger.getRecord(paymentRequest.requestId);
      if (pastRecord && pastRecord.paypalCalled) {
        throw new Error(`Security Violation: Request "${paymentRequest.requestId}" has already executed payment.`);
      }
    }

    const activePolicy = currentPolicy || policySnapshot;
    const aiAnalysis = await this.gateway.aiProvider.analyze(paymentRequest);
    const dailySpentSoFar = this.storage
      ? await this.storage.getDailySpend(paymentRequest.agentId, (paymentRequest.timestamp || new Date().toISOString()).split('T')[0])
      : this.gateway.ledger.getDailySpend(paymentRequest.agentId);

    const reEvalDecision = evaluateAuthorization({
      paymentRequest,
      aiAnalysis,
      policy: activePolicy,
      ledger: null,
      dailySpentSoFar
    });

    if (reEvalDecision.decision === 'BLOCK') {
      approvalRequest.status = APPROVAL_STATES.REJECTED;

      if (this.storage) {
        await this.storage.resolveApproval(approvalId, {
          status: APPROVAL_STATES.REJECTED,
          resolutionNote: `Policy tightened prior to approval resolution: ${reEvalDecision.explanation}`
        });
        await this.storage.releaseClaim(paymentRequest.requestId);
      }

      this.gateway.auditLogger.logEvent({
        eventType: AUDIT_EVENT_TYPES.BLOCKED,
        requestId: paymentRequest.requestId,
        agentId: paymentRequest.agentId,
        decision: 'BLOCK',
        reasonCodes: reEvalDecision.reasonCodes,
        explanation: `Security Re-evaluation Failure: Policy changed prior to human approval. Execution blocked: ${reEvalDecision.explanation}`,
        paypalCalled: false,
        details: { approvalId }
      });

      await this.gateway.receiptLog.append({
        mandateId: this.gateway.spendingMandate.mandateId,
        requestId: paymentRequest.requestId,
        request: paymentRequest,
        decision: 'BLOCK',
        reasonCodes: reEvalDecision.reasonCodes,
        paypalCalled: false,
        note: `Policy tightened prior to approval resolution: ${reEvalDecision.explanation}`
      });

      return {
        success: false,
        approvalStatus: APPROVAL_STATES.REJECTED,
        reason: `Re-evaluation blocked: ${reEvalDecision.explanation}`,
        paypalResult: null
      };
    }

    approvalRequest.status = APPROVAL_STATES.APPROVED;

    this.gateway.auditLogger.logEvent({
      eventType: AUDIT_EVENT_TYPES.APPROVAL_GRANTED,
      requestId: paymentRequest.requestId,
      agentId: paymentRequest.agentId,
      decision: 'APPROVED',
      reasonCodes: ['POLICY_ALLOWED'],
      explanation: `Human operator approved request "${paymentRequest.requestId}". Initiating payment execution.`,
      paypalCalled: false,
      details: { approvalId }
    });

    this.gateway.auditLogger.logEvent({
      eventType: AUDIT_EVENT_TYPES.PAYPAL_REQUESTED,
      requestId: paymentRequest.requestId,
      agentId: paymentRequest.agentId,
      explanation: `Invoking PayPal API adapter post-approval.`,
      paypalCalled: true,
      details: { approvalId }
    });

    const paypalResult = await this.gateway.processor.createPayment(paymentRequest);

    this.gateway.auditLogger.logEvent({
      eventType: AUDIT_EVENT_TYPES.PAYPAL_RESPONSE_RECEIVED,
      requestId: paymentRequest.requestId,
      agentId: paymentRequest.agentId,
      explanation: `PayPal response received. Status: ${paypalResult.status}`,
      paypalCalled: true,
      details: { approvalId, orderId: paypalResult.orderId }
    });

    if (paypalResult.success) {
      this.gateway.ledger.addDailySpend(paymentRequest.agentId, paymentRequest.amount.value);
    }

    if (this.storage) {
      await this.storage.recordRequestResult(paymentRequest.requestId, {
        agentId: paymentRequest.agentId,
        amount: paymentRequest.amount.value,
        currency: paymentRequest.amount.currency || 'USD',
        spendDate: (paymentRequest.timestamp || new Date().toISOString()).split('T')[0],
        status: paypalResult.success ? 'SUCCESS' : 'FAILED',
        decision: 'ALLOW',
        reasonCodes: ['HUMAN_APPROVED'],
        paypalCalled: Boolean(paypalResult && paypalResult.success),
        paypalRef: paypalResult ? (paypalResult.orderId || paypalResult.batchId) : null,
        batchStatus: paypalResult?.batchStatus || null
      });
    }

    this.gateway.ledger.record(paymentRequest.requestId, {
      decision: 'ALLOW',
      reasonCodes: ['HUMAN_APPROVED'],
      paypalCalled: Boolean(paypalResult && paypalResult.success)
    });

    // Append post-approval signed receipt
    await this.gateway.receiptLog.append({
      mandateId: this.gateway.spendingMandate.mandateId,
      requestId: paymentRequest.requestId,
      request: paymentRequest,
      decision: 'APPROVED',
      reasonCodes: ['HUMAN_APPROVED'],
      paypalCalled: Boolean(paypalResult && paypalResult.success),
      paypalRef: paypalResult ? paypalResult.orderId : null,
      note: `Human operator approved escalated transaction.`
    });

    return {
      success: true,
      approvalStatus: APPROVAL_STATES.APPROVED,
      paypalResult
    };
  }

  rejectRequest(approvalId, reason = 'Rejected by human operator') {
    const record = this.approvals.get(String(approvalId));
    if (!record) {
      throw new Error(`Approval "${approvalId}" not found.`);
    }

    const { approvalRequest, paymentRequest } = record;

    if (this.storage) {
      this.storage.resolveApproval(approvalId, {
        status: APPROVAL_STATES.REJECTED,
        resolutionNote: reason
      }).then(atomicResolved => {
        if (!atomicResolved) {
          console.error(`[PayGuard Approvals] Warning: Reject on ${approvalId} failed atomic resolution`);
        }
        if (paymentRequest?.requestId) {
          return this.storage.releaseClaim(paymentRequest.requestId);
        }
      }).catch(err => {
        console.error('[PayGuard Approvals] Warning: Failed to reject approval in storage:', err.message);
      });
    }

    approvalRequest.status = APPROVAL_STATES.REJECTED;

    if (this.gateway?.auditLogger) {
      this.gateway.auditLogger.logEvent({
        eventType: AUDIT_EVENT_TYPES.APPROVAL_REJECTED,
        requestId: paymentRequest.requestId,
        agentId: paymentRequest.agentId,
        decision: 'REJECTED',
        reasonCodes: ['POLICY_APPROVAL_REQUIRED'],
        explanation: `Human operator rejected request "${paymentRequest.requestId}". Reason: ${reason}`,
        paypalCalled: false,
        details: { approvalId, reason }
      });
    }

    this.gateway.receiptLog.append({
      mandateId: this.gateway.spendingMandate.mandateId,
      requestId: paymentRequest.requestId,
      request: paymentRequest,
      decision: 'REJECTED',
      reasonCodes: ['HUMAN_REJECTED'],
      paypalCalled: false,
      note: `Human operator rejected request: ${reason}`
    });

    return {
      approvalStatus: APPROVAL_STATES.REJECTED,
      approvalRequest
    };
  }

  async rejectRequestAsync(approvalId, reason = 'Rejected by human operator') {
    let record = this.approvals.get(String(approvalId));
    if (!record && this.storage) {
      await this.getApprovalAsync(approvalId);
      record = this.approvals.get(String(approvalId));
    }

    if (!record) {
      throw new Error(`Approval "${approvalId}" not found.`);
    }

    const { approvalRequest, paymentRequest } = record;

    if (this.storage) {
      const atomicResolved = await this.storage.resolveApproval(approvalId, {
        status: APPROVAL_STATES.REJECTED,
        resolutionNote: reason
      });
      if (!atomicResolved) {
        throw new Error(`Cannot reject: Approval "${approvalId}" is already resolved or not found.`);
      }
      if (paymentRequest?.requestId) {
        await this.storage.releaseClaim(paymentRequest.requestId);
      }
    }

    approvalRequest.status = APPROVAL_STATES.REJECTED;

    if (this.gateway?.auditLogger) {
      this.gateway.auditLogger.logEvent({
        eventType: AUDIT_EVENT_TYPES.APPROVAL_REJECTED,
        requestId: paymentRequest.requestId,
        agentId: paymentRequest.agentId,
        decision: 'REJECTED',
        reasonCodes: ['POLICY_APPROVAL_REQUIRED'],
        explanation: `Human operator rejected request "${paymentRequest.requestId}". Reason: ${reason}`,
        paypalCalled: false,
        details: { approvalId, reason }
      });
    }

    await this.gateway.receiptLog.append({
      mandateId: this.gateway.spendingMandate.mandateId,
      requestId: paymentRequest.requestId,
      request: paymentRequest,
      decision: 'REJECTED',
      reasonCodes: ['HUMAN_REJECTED'],
      paypalCalled: false,
      note: `Human operator rejected request: ${reason}`
    });

    return {
      approvalStatus: APPROVAL_STATES.REJECTED,
      approvalRequest
    };
  }

  expireRequest(approvalId) {
    const record = this.approvals.get(String(approvalId));
    if (!record) return null;

    const { approvalRequest, paymentRequest } = record;
    approvalRequest.status = APPROVAL_STATES.EXPIRED;

    this.gateway.auditLogger.logEvent({
      eventType: AUDIT_EVENT_TYPES.APPROVAL_EXPIRED,
      requestId: paymentRequest.requestId,
      agentId: paymentRequest.agentId,
      decision: 'EXPIRED',
      explanation: `Approval "${approvalId}" manually expired.`,
      paypalCalled: false,
      details: { approvalId }
    });

    return approvalRequest;
  }
}
