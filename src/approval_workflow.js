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
  constructor({ gateway }) {
    this.gateway = gateway;
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

    this.approvals.set(approvalObj.approvalId, {
      approvalRequest: approvalObj,
      paymentRequest,
      policySnapshot: { ...policy }
    });

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

    return approvalObj;
  }

  getApproval(approvalId) {
    const record = this.approvals.get(String(approvalId));
    if (!record) return null;

    if (record.approvalRequest.status === APPROVAL_STATES.PENDING) {
      if (new Date() > new Date(record.approvalRequest.expiresAt)) {
        record.approvalRequest.status = APPROVAL_STATES.EXPIRED;
        this.gateway.auditLogger.logEvent({
          eventType: AUDIT_EVENT_TYPES.APPROVAL_EXPIRED,
          requestId: record.paymentRequest.requestId,
          agentId: record.paymentRequest.agentId,
          decision: 'EXPIRED',
          explanation: `Approval "${approvalId}" expired before human resolution.`,
          paypalCalled: false,
          details: { approvalId }
        });
      }
    }

    return record.approvalRequest;
  }

  getAllApprovals() {
    for (const id of this.approvals.keys()) {
      this.getApproval(id);
    }
    return Array.from(this.approvals.values()).map(r => r.approvalRequest);
  }

  async approveRequest(approvalId, currentPolicy = null) {
    const record = this.approvals.get(String(approvalId));
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

    if (this.gateway.ledger.hasSeen(paymentRequest.requestId)) {
      const pastRecord = this.gateway.ledger.getRecord(paymentRequest.requestId);
      if (pastRecord && pastRecord.paypalCalled) {
        throw new Error(`Security Violation: Request "${paymentRequest.requestId}" has already executed payment.`);
      }
    }

    const activePolicy = currentPolicy || policySnapshot;
    const aiAnalysis = await this.gateway.aiProvider.analyze(paymentRequest);
    const dailySpentSoFar = this.gateway.ledger.getDailySpend(paymentRequest.agentId);

    const reEvalDecision = evaluateAuthorization({
      paymentRequest,
      aiAnalysis,
      policy: activePolicy,
      ledger: null,
      dailySpentSoFar
    });

    if (reEvalDecision.decision === 'BLOCK') {
      approvalRequest.status = APPROVAL_STATES.REJECTED;
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

      this.gateway.receiptLog.append({
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

    this.gateway.ledger.record(paymentRequest.requestId, {
      decision: 'ALLOW',
      reasonCodes: ['HUMAN_APPROVED'],
      paypalCalled: Boolean(paypalResult && paypalResult.success)
    });

    // Append post-approval signed receipt
    this.gateway.receiptLog.append({
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
    approvalRequest.status = APPROVAL_STATES.REJECTED;

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
