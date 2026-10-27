import { evaluateAuthorization } from './decision_engine.js';
import { createAuditEvent, createAIAnalysis } from './models.js';
import { IdempotencyLedger } from './ledger.js';
import { PayPalSandboxProcessor } from './paypal_adapter.js';
import { getAIAnalysisProvider } from './ai_analysis.js';
import { AuditLogger, AUDIT_EVENT_TYPES } from './audit_logger.js';
import { ApprovalWorkflowManager } from './approval_workflow.js';
import { createSpendingMandate, verifyMandate, generateKeyPair } from './mandate.js';
import { ReceiptLog } from './receipts.js';
import { PayGuardMerchantRegistry } from './merchant_registry.js';

export class PayGuardGateway {
  constructor({
    processor,
    ledger,
    aiProvider,
    auditLogger,
    policy,
    adminPublicKey,
    gatewayPrivateKey,
    keyPair,
    merchantRegistry,
    spendingMandate,
    storage
  } = {}) {
    this.storage = storage || null;
    this.processor = processor || new PayPalSandboxProcessor();
    this.ledger = ledger || new IdempotencyLedger();
    this.aiProvider = aiProvider || getAIAnalysisProvider();
    this.auditLogger = auditLogger || new AuditLogger();
    this.merchantRegistry = merchantRegistry || new PayGuardMerchantRegistry();

    // Default policy
    this.activePolicy = policy || {
      policyId: 'policy_devops_01',
      name: 'DevOps Agent Policy',
      maxTransactionAmount: 200,
      dailyBudget: 1000,
      allowedCategories: ['cloud_infrastructure', 'developer_tools'],
      newMerchantRequiresApproval: true,
      suspiciousMerchantAction: 'BLOCK',
      highRiskAction: 'REQUIRE_APPROVAL'
    };

    // 1. Separate Trust Boundary: Admin Public Key for Mandate Verification
    // The Gateway holds ONLY the public key. It NEVER requires or stores the Admin private key.
    let ephemeralAdminPrivate = null;
    if (adminPublicKey !== undefined) {
      this.adminPublicKey = adminPublicKey;
    } else if (process.env.PAYGUARD_ADMIN_PUBLIC_KEY) {
      this.adminPublicKey = process.env.PAYGUARD_ADMIN_PUBLIC_KEY.trim();
    } else {
      // Dev/test fallback: generate ephemeral admin key to sign the default mandate,
      // but discard the private key immediately after initialization.
      const ephemeralAdminKeys = generateKeyPair();
      this.adminPublicKey = ephemeralAdminKeys.publicKey;
      ephemeralAdminPrivate = ephemeralAdminKeys.privateKey;
    }

    // 2. Spending Mandate
    if (spendingMandate) {
      this.spendingMandate = spendingMandate;
    } else if (ephemeralAdminPrivate) {
      this.spendingMandate = createSpendingMandate({
        policy: this.activePolicy,
        authorityName: 'Human Owner',
        expiresInDays: 30,
        privateKey: ephemeralAdminPrivate
      });
      ephemeralAdminPrivate = null; // Strictly wiped
    } else {
      this.spendingMandate = {
        mandateId: 'mandate_unconfigured',
        policy: this.activePolicy,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        signature: null
      };
    }

    // 3. Separate Trust Boundary: Gateway Receipt Signing Key
    // Gateway uses its own independent private key for signing audit receipts.
    this.receiptLog = new ReceiptLog({
      gatewayPrivateKey: gatewayPrivateKey || keyPair?.privateKey || process.env.PAYGUARD_GATEWAY_PRIVATE_KEY,
      keyPair,
      storage: this.storage
    });

    this.approvalManager = new ApprovalWorkflowManager({ gateway: this, storage: this.storage });
  }

  /**
   * Primary Gateway Pipeline
   */
  async processRequest({ paymentRequest, aiAnalysis, policy }) {
    const activePolicy = policy || this.activePolicy;

    // 0a. Verify Signed Spending Mandate against TRUSTED Admin Public Key
    const mandateCheck = verifyMandate(this.spendingMandate, { trustedAdminPublicKey: this.adminPublicKey });
    if (!mandateCheck.valid) {
      const decision = {
        decision: 'BLOCK',
        status: 'BLOCKED',
        reasonCodes: ['MANDATE_INVALID'],
        explanation: `Mandate Verification Failed: ${mandateCheck.reason}`,
        riskLevel: 'critical',
        policyId: activePolicy.policyId,
        requestId: paymentRequest.requestId,
        paypalCallAllowed: false,
      };

      this.auditLogger.logEvent({
        eventType: AUDIT_EVENT_TYPES.BLOCKED,
        requestId: paymentRequest.requestId,
        agentId: paymentRequest.agentId,
        decision: 'BLOCK',
        reasonCodes: ['MANDATE_INVALID'],
        explanation: decision.explanation,
        paypalCalled: false
      });

      await this.receiptLog.append({
        mandateId: this.spendingMandate.mandateId,
        requestId: paymentRequest.requestId,
        request: paymentRequest,
        decision: 'BLOCK',
        reasonCodes: ['MANDATE_INVALID'],
        paypalCalled: false,
        note: decision.explanation
      });

      return { decision, aiAnalysis: null, paypalResult: null, approvalRequest: null };
    }

    // 0b. Atomic Idempotency Claim & Spend Reservation (Concurrency Protection)
    const reqAmount = paymentRequest.amount?.value ?? paymentRequest.amount;
    const dateStr = (paymentRequest.timestamp || new Date().toISOString()).split('T')[0];

    if (this.storage) {
      const claimResult = await this.storage.claimRequest({
        requestId: paymentRequest.requestId,
        agentId: paymentRequest.agentId,
        amount: reqAmount,
        dateStr,
        maxDailyBudget: activePolicy.dailyBudget || Infinity
      });

      if (!claimResult.success) {
        if (claimResult.isDuplicate) {
          const decision = {
            decision: 'BLOCK',
            status: 'REJECTED_DUPLICATE',
            reasonCodes: ['DUPLICATE_REQUEST'],
            explanation: `Duplicate request detected for requestId "${paymentRequest.requestId}". Execution rejected by PayGuard storage ledger.`,
            riskLevel: 'critical',
            policyId: activePolicy.policyId,
            requestId: paymentRequest.requestId,
            paypalCallAllowed: false,
          };

          this.auditLogger.logEvent({
            eventType: AUDIT_EVENT_TYPES.DUPLICATE_REJECTED,
            requestId: paymentRequest.requestId,
            agentId: paymentRequest.agentId,
            decision: 'BLOCK',
            reasonCodes: ['DUPLICATE_REQUEST'],
            explanation: decision.explanation,
            paypalCalled: false
          });

          await this.receiptLog.append({
            mandateId: this.spendingMandate.mandateId,
            requestId: paymentRequest.requestId,
            request: paymentRequest,
            decision: 'BLOCK',
            reasonCodes: ['DUPLICATE_REQUEST'],
            paypalCalled: false,
            note: decision.explanation
          });

          return { decision, aiAnalysis: null, paypalResult: null, approvalRequest: null };
        }

        if (claimResult.budgetExceeded) {
          const decision = {
            decision: 'BLOCK',
            status: 'BLOCKED',
            reasonCodes: ['DAILY_BUDGET_EXCEEDED'],
            explanation: `Daily budget exceeded for agent "${paymentRequest.agentId}". Spent: $${claimResult.currentSpend}, Requested: $${reqAmount}, Budget: $${activePolicy.dailyBudget}.`,
            riskLevel: 'high',
            policyId: activePolicy.policyId,
            requestId: paymentRequest.requestId,
            paypalCallAllowed: false,
          };

          this.auditLogger.logEvent({
            eventType: AUDIT_EVENT_TYPES.BLOCKED,
            requestId: paymentRequest.requestId,
            agentId: paymentRequest.agentId,
            decision: 'BLOCK',
            reasonCodes: ['DAILY_BUDGET_EXCEEDED'],
            explanation: decision.explanation,
            paypalCalled: false
          });

          await this.receiptLog.append({
            mandateId: this.spendingMandate.mandateId,
            requestId: paymentRequest.requestId,
            request: paymentRequest,
            decision: 'BLOCK',
            reasonCodes: ['DAILY_BUDGET_EXCEEDED'],
            paypalCalled: false,
            note: decision.explanation
          });

          return { decision, aiAnalysis: null, paypalResult: null, approvalRequest: null };
        }
      }
    } else {
      // Ephemeral fallback using in-memory ledger
      const isFirstClaim = this.ledger.claim(paymentRequest.requestId);
      if (!isFirstClaim) {
        const decision = {
          decision: 'BLOCK',
          status: 'REJECTED_DUPLICATE',
          reasonCodes: ['DUPLICATE_REQUEST'],
          explanation: `Duplicate request detected for requestId "${paymentRequest.requestId}". Execution rejected by PayGuard ledger.`,
          riskLevel: 'critical',
          policyId: activePolicy.policyId,
          requestId: paymentRequest.requestId,
          paypalCallAllowed: false,
        };

        this.auditLogger.logEvent({
          eventType: AUDIT_EVENT_TYPES.DUPLICATE_REJECTED,
          requestId: paymentRequest.requestId,
          agentId: paymentRequest.agentId,
          decision: 'BLOCK',
          reasonCodes: ['DUPLICATE_REQUEST'],
          explanation: decision.explanation,
          paypalCalled: false
        });

        await this.receiptLog.append({
          mandateId: this.spendingMandate.mandateId,
          requestId: paymentRequest.requestId,
          request: paymentRequest,
          decision: 'BLOCK',
          reasonCodes: ['DUPLICATE_REQUEST'],
          paypalCalled: false,
          note: decision.explanation
        });

        return { decision, aiAnalysis: null, paypalResult: null, approvalRequest: null };
      }
    }

    // 1. Audit Log: REQUEST_RECEIVED
    this.auditLogger.logEvent({
      eventType: AUDIT_EVENT_TYPES.REQUEST_RECEIVED,
      requestId: paymentRequest.requestId,
      agentId: paymentRequest.agentId,
      explanation: `Payment request received for $${paymentRequest.amount.value} ${paymentRequest.amount.currency} to "${paymentRequest.merchant.name}".`,
      details: { merchant: paymentRequest.merchant, amount: paymentRequest.amount }
    });

    // 2. AI Context Analysis (Advisory Evidence)
    const analysis = aiAnalysis || await this.aiProvider.analyze(paymentRequest);

    this.auditLogger.logEvent({
      eventType: AUDIT_EVENT_TYPES.AI_ANALYZED,
      requestId: paymentRequest.requestId,
      agentId: paymentRequest.agentId,
      explanation: `AI Context Analysis completed. Anomaly: ${analysis.anomalyLevel}, Injection: ${analysis.injectionDetected ? 'DETECTED' : 'CLEAN'}, Risk: ${analysis.merchantRisk}.`,
      details: {
        anomalyLevel: analysis.anomalyLevel,
        merchantRisk: analysis.merchantRisk,
        injectionDetected: analysis.injectionDetected,
        reasoningSummary: analysis.reasoningSummary
      }
    });

    // 3. Resolve Merchant Trust via Application Registry
    const merchantTrust = this.merchantRegistry.evaluateMerchantTrust(paymentRequest);

    // 4. Fetch agent's daily spend so far
    const dailySpentSoFar = this.storage
      ? await this.storage.getDailySpend(paymentRequest.agentId, dateStr)
      : this.ledger.getDailySpend(paymentRequest.agentId);

    // 5. Deterministic Policy Evaluation (Sole Authority)
    const decision = evaluateAuthorization({
      paymentRequest,
      aiAnalysis: analysis,
      policy: activePolicy,
      ledger: null, // Claim handled in step 0b
      dailySpentSoFar,
      merchantTrustInfo: merchantTrust
    });

    this.auditLogger.logEvent({
      eventType: AUDIT_EVENT_TYPES.POLICY_EVALUATED,
      requestId: paymentRequest.requestId,
      agentId: paymentRequest.agentId,
      decision: decision.decision,
      reasonCodes: decision.reasonCodes,
      explanation: `Deterministic policy evaluated. Decision: ${decision.decision}. ${decision.explanation}`,
      details: { policyId: activePolicy.policyId, riskLevel: decision.riskLevel, merchantTrust }
    });

    let paypalResult = null;
    let approvalRequest = null;

    // 6. Execution Boundary
    if (decision.decision === 'ALLOW' && decision.paypalCallAllowed) {
      this.auditLogger.logEvent({
        eventType: AUDIT_EVENT_TYPES.PAYPAL_REQUESTED,
        requestId: paymentRequest.requestId,
        agentId: paymentRequest.agentId,
        explanation: `Invoking PayPal REST API processor for approved transaction.`,
        paypalCalled: true
      });

      const pyResult = await this.processor.createPayment(paymentRequest);
      paypalResult = pyResult;

      this.auditLogger.logEvent({
        eventType: AUDIT_EVENT_TYPES.PAYPAL_RESPONSE_RECEIVED,
        requestId: paymentRequest.requestId,
        agentId: paymentRequest.agentId,
        explanation: `PayPal REST API response received. HTTP Status: ${pyResult.status}`,
        paypalCalled: true,
        details: { status: pyResult.status, orderId: pyResult.orderId, batchId: pyResult.batchId }
      });

      // Reserve daily spend when status is SUCCESS, PENDING, PROCESSING, or uncertain
      const isPendingOrProcessing = ['PENDING', 'PROCESSING'].includes(pyResult.batchStatus);
      if (pyResult.success || pyResult.uncertain || isPendingOrProcessing) {
        this.ledger.addDailySpend(paymentRequest.agentId, reqAmount);
      } else if (!pyResult.success && !pyResult.uncertain) {
        // Hard failure: release the spend reservation
        if (this.storage) {
          await this.storage.releaseClaim(paymentRequest.requestId);
        }
      }

      // Mark uncertain outcome for reconciliation
      if (pyResult.uncertain) {
        decision.status = 'NEEDS_RECONCILIATION';
        decision.explanation = `Execution state uncertain: ${pyResult.error?.message || 'Payout outcome uncertain'}. Reconciliation required.`;
      }
    } else if (decision.decision === 'REQUIRE_APPROVAL') {
      approvalRequest = this.approvalManager.createApproval({
        paymentRequest,
        policy: activePolicy,
        riskLevel: decision.riskLevel,
        reason: decision.explanation
      });
      if (this.approvalManager.flushPendingApprovals) {
        await this.approvalManager.flushPendingApprovals();
      }
    } else if (decision.decision === 'BLOCK') {
      if (this.storage) {
        await this.storage.releaseClaim(paymentRequest.requestId);
      }
      const isDuplicate = decision.reasonCodes.includes('DUPLICATE_REQUEST');
      this.auditLogger.logEvent({
        eventType: isDuplicate ? AUDIT_EVENT_TYPES.DUPLICATE_REJECTED : AUDIT_EVENT_TYPES.BLOCKED,
        requestId: paymentRequest.requestId,
        agentId: paymentRequest.agentId,
        decision: 'BLOCK',
        reasonCodes: decision.reasonCodes,
        explanation: `Transaction hard-blocked: ${decision.explanation}`,
        paypalCalled: false
      });
    }

    // Finalize record in storage
    if (this.storage) {
      await this.storage.recordRequestResult(paymentRequest.requestId, {
        agentId: paymentRequest.agentId,
        amount: reqAmount,
        currency: paymentRequest.amount?.currency || 'USD',
        spendDate: dateStr,
        status: decision.status,
        decision: decision.decision,
        reasonCodes: decision.reasonCodes,
        paypalCalled: Boolean(paypalResult && (paypalResult.success || paypalResult.uncertain)),
        paypalRef: paypalResult ? (paypalResult.batchId || paypalResult.orderId) : null,
        batchStatus: paypalResult?.batchStatus || null,
        itemStatus: paypalResult?.raw?.items?.[0]?.transaction_status || (paypalResult?.uncertain ? 'UNCERTAIN' : null),
        metadata: {
          riskLevel: decision.riskLevel,
          explanation: decision.explanation
        }
      });
    }

    // Finalize record in ledger
    this.ledger.record(paymentRequest.requestId, {
      decision: decision.decision,
      status: decision.status,
      reasonCodes: decision.reasonCodes,
      paypalCalled: Boolean(paypalResult && (paypalResult.success || paypalResult.uncertain))
    });

    // 7. Create Signed Evidence Receipt
    await this.receiptLog.append({
      mandateId: this.spendingMandate.mandateId,
      requestId: paymentRequest.requestId,
      request: paymentRequest,
      decision: decision.decision,
      reasonCodes: decision.reasonCodes,
      paypalCalled: Boolean(paypalResult && (paypalResult.success || paypalResult.uncertain)),
      paypalRef: paypalResult ? (paypalResult.batchId || paypalResult.orderId) : null,
      batchStatus: paypalResult?.batchStatus || null,
      payoutItemStatus: paypalResult?.raw?.items?.[0]?.transaction_status || (paypalResult?.uncertain ? 'UNCERTAIN' : null),
      payoutBatchId: paypalResult?.batchId || null,
      reconciliationNeeded: Boolean(paypalResult?.uncertain),
      note: decision.explanation,
      merchantTrust
    });

    return {
      decision,
      aiAnalysis: analysis,
      merchantTrust,
      paypalResult,
      approvalRequest,
      mandate: this.spendingMandate
    };
  }

  /**
   * Polls PayPal API for live payout batch and item status
   */
  async pollPayoutStatus(batchId, client = null) {
    if (!batchId) throw new Error('batchId is required to poll payout status');
    const getBatch = client?.getPayoutBatch || (await import('../paypal_client.js')).getPayoutBatch;
    const res = await getBatch(batchId);
    if (!res.ok) {
      return { success: false, status: res.status, error: res.data };
    }
    const batchHeader = res.data?.batch_header || {};
    const item = res.data?.items?.[0] || {};
    return {
      success: true,
      batchId: batchHeader.payout_batch_id || batchId,
      batchStatus: batchHeader.batch_status || 'UNKNOWN',
      itemStatus: item.transaction_status || 'UNKNOWN',
      transactionId: item.transaction_id || null,
      amount: batchHeader.amount,
      raw: res.data
    };
  }
}

