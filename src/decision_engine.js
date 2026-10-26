export const REASON_CODES = {
  DUPLICATE_REQUEST: 'DUPLICATE_REQUEST',
  PROMPT_INJECTION_DETECTED: 'PROMPT_INJECTION_DETECTED',
  CATEGORY_NOT_ALLOWED: 'CATEGORY_NOT_ALLOWED',
  AGENT_CATEGORY_MISMATCH: 'AGENT_CATEGORY_MISMATCH',
  PAYEE_OVERRIDE_ATTEMPT: 'PAYEE_OVERRIDE_ATTEMPT',
  SUSPICIOUS_MERCHANT: 'SUSPICIOUS_MERCHANT',
  DAILY_BUDGET_EXCEEDED: 'DAILY_BUDGET_EXCEEDED',
  AMOUNT_LIMIT_EXCEEDED: 'AMOUNT_LIMIT_EXCEEDED',
  NEW_MERCHANT: 'NEW_MERCHANT',
  HIGH_RISK_INTENT: 'HIGH_RISK_INTENT',
  POLICY_APPROVAL_REQUIRED: 'POLICY_APPROVAL_REQUIRED',
  POLICY_ALLOWED: 'POLICY_ALLOWED',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
};

export function evaluateAuthorization({
  paymentRequest,
  aiAnalysis,
  policy,
  ledger,
  dailySpentSoFar = 0,
  merchantTrustInfo = null
}) {
  const reasonCodes = [];
  const requestId = paymentRequest.requestId;
  const trustInfo = merchantTrustInfo || paymentRequest.merchantTrustInfo || null;

  // 1. DUPLICATE_REQUEST (Precedence 1)
  if (ledger && ledger.hasSeen(requestId)) {
    reasonCodes.push(REASON_CODES.DUPLICATE_REQUEST);
    return {
      decision: 'BLOCK',
      status: 'REJECTED_DUPLICATE',
      reasonCodes,
      explanation: `Duplicate request detected for requestId "${requestId}". Execution rejected by PayGuard ledger.`,
      riskLevel: 'critical',
      policyId: policy.policyId,
      requestId,
      paypalCallAllowed: false,
    };
  }

  // 1b. MALFORMED / NON-POSITIVE / INVALID AMOUNT CHECK (Precedence 1b)
  const amountVal = Number(paymentRequest.amount?.value);
  if (isNaN(amountVal) || amountVal <= 0 || !isFinite(amountVal)) {
    reasonCodes.push(REASON_CODES.INVALID_AMOUNT);
    return {
      decision: 'BLOCK',
      status: 'BLOCKED',
      reasonCodes,
      explanation: `Invalid transaction amount ($${paymentRequest.amount?.value}). Payment amount must be a positive finite number.`,
      riskLevel: 'high',
      policyId: policy.policyId,
      requestId,
      paypalCallAllowed: false,
    };
  }

  // 1c. AGENT CATEGORY MISMATCH (Precedence 1c - Hard Block on Claim Spoofing)
  if (trustInfo?.categoryMismatchDetected) {
    reasonCodes.push(REASON_CODES.AGENT_CATEGORY_MISMATCH);
    return {
      decision: 'BLOCK',
      status: 'BLOCKED',
      reasonCodes,
      explanation: `Agent Category Mismatch: Agent claimed category "${trustInfo.agentClaimedCategory}" does not match authoritative registry category "${trustInfo.verifiedCategory}".`,
      riskLevel: 'critical',
      policyId: policy.policyId,
      requestId,
      paypalCallAllowed: false,
    };
  }

  // 1d. PAYEE OVERRIDE ATTEMPT (Precedence 1d - Hard Block on Destination Spoofing)
  if (trustInfo?.recipientOverrideAttempt) {
    reasonCodes.push(REASON_CODES.PAYEE_OVERRIDE_ATTEMPT);
    return {
      decision: 'BLOCK',
      status: 'BLOCKED',
      reasonCodes,
      explanation: `Payee Override Attempt: Payment request attempted to supply an unauthorized payout recipient ("${trustInfo.agentClaimedEmail}") overriding registered merchant payout address.`,
      riskLevel: 'critical',
      policyId: policy.policyId,
      requestId,
      paypalCallAllowed: false,
    };
  }

  // 2. HARD_BLOCK_POLICY — Category Check (Precedence 2)
  const category = trustInfo?.verifiedCategory || paymentRequest.merchant.category || aiAnalysis.category || 'general';
  if (policy.allowedCategories && policy.allowedCategories.length > 0 && !policy.allowedCategories.includes(category)) {
    reasonCodes.push(REASON_CODES.CATEGORY_NOT_ALLOWED);
    return {
      decision: 'BLOCK',
      status: 'BLOCKED',
      reasonCodes,
      explanation: `Merchant category "${category}" is not in allowed policy categories [${policy.allowedCategories.join(', ')}].`,
      riskLevel: 'high',
      policyId: policy.policyId,
      requestId,
      paypalCallAllowed: false,
    };
  }

  // 2b. HARD_BLOCK_POLICY — Suspicious Merchant Check (Precedence 2)
  if (aiAnalysis.merchantRisk === 'suspicious' || paymentRequest.merchant.isSuspicious) {
    reasonCodes.push(REASON_CODES.SUSPICIOUS_MERCHANT);
    const action = policy.suspiciousMerchantAction || 'BLOCK';
    return {
      decision: action,
      status: action === 'BLOCK' ? 'BLOCKED' : 'ESCALATED',
      reasonCodes,
      explanation: `Merchant "${paymentRequest.merchant.name}" flagged as suspicious by intelligence feed. Action: ${action}.`,
      riskLevel: 'critical',
      policyId: policy.policyId,
      requestId,
      paypalCallAllowed: false,
    };
  }

  // 3. INJECTION_DETECTED (Precedence 3)
  if (aiAnalysis.injectionDetected) {
    reasonCodes.push(REASON_CODES.PROMPT_INJECTION_DETECTED);
    return {
      decision: 'BLOCK',
      status: 'BLOCKED',
      reasonCodes,
      explanation: `Prompt injection / agent hijack attack detected in payment request payload. Indicators: ${aiAnalysis.injectionIndicators.join('; ')}`,
      riskLevel: 'critical',
      policyId: policy.policyId,
      requestId,
      paypalCallAllowed: false,
    };
  }

  // 4. DAILY_BUDGET_EXCEEDED (Precedence 4)
  const projectTotalDaily = dailySpentSoFar + amountVal;
  if (projectTotalDaily > policy.dailyBudget) {
    reasonCodes.push(REASON_CODES.DAILY_BUDGET_EXCEEDED);
    return {
      decision: 'BLOCK',
      status: 'BLOCKED',
      reasonCodes,
      explanation: `Request amount ($${amountVal}) pushes cumulative daily spend ($${projectTotalDaily}) past daily budget limit ($${policy.dailyBudget}).`,
      riskLevel: 'high',
      policyId: policy.policyId,
      requestId,
      paypalCallAllowed: false,
    };
  }

  // 5. TRANSACTION_LIMIT_EXCEEDED (Precedence 5)
  if (amountVal > policy.maxTransactionAmount) {
    reasonCodes.push(REASON_CODES.AMOUNT_LIMIT_EXCEEDED);
    
    // Extreme amounts (e.g. >= 1000 or 5x max amount) trigger hard BLOCK; moderate overages trigger REQUIRE_APPROVAL
    if (amountVal >= 1000 || amountVal >= policy.maxTransactionAmount * 5) {
      return {
        decision: 'BLOCK',
        status: 'BLOCKED',
        reasonCodes,
        explanation: `Transaction amount ($${amountVal}) exceeds maximum allowable threshold ($${policy.maxTransactionAmount}) by extreme margin. Hard-blocked by policy.`,
        riskLevel: 'high',
        policyId: policy.policyId,
        requestId,
        paypalCallAllowed: false,
      };
    }

    reasonCodes.push(REASON_CODES.POLICY_APPROVAL_REQUIRED);
    return {
      decision: 'REQUIRE_APPROVAL',
      status: 'ESCALATED',
      reasonCodes,
      explanation: `Transaction amount ($${amountVal}) exceeds single-transaction policy limit ($${policy.maxTransactionAmount}). Escalated for human manager approval.`,
      riskLevel: 'medium',
      policyId: policy.policyId,
      requestId,
      paypalCallAllowed: false,
    };
  }

  // 6. NEW_MERCHANT_REQUIRES_APPROVAL (Precedence 6)
  const isNewMerchant = (trustInfo ? !trustInfo.known : paymentRequest.merchant.isKnown === false) || paymentRequest.context.isNewMerchant === true;
  if (isNewMerchant && policy.newMerchantRequiresApproval) {
    reasonCodes.push(REASON_CODES.NEW_MERCHANT);
    reasonCodes.push(REASON_CODES.POLICY_APPROVAL_REQUIRED);
    return {
      decision: 'REQUIRE_APPROVAL',
      status: 'ESCALATED',
      reasonCodes,
      explanation: `Merchant "${paymentRequest.merchant.name}" is a newly encountered vendor. Human approval required per policy.`,
      riskLevel: 'medium',
      policyId: policy.policyId,
      requestId,
      paypalCallAllowed: false,
    };
  }

  // 7. HIGH_RISK_REQUIRES_APPROVAL (Precedence 7)
  if (aiAnalysis.anomalyLevel === 'high' || aiAnalysis.merchantRisk === 'high') {
    reasonCodes.push(REASON_CODES.HIGH_RISK_INTENT);
    const riskAction = policy.highRiskAction || 'REQUIRE_APPROVAL';
    return {
      decision: riskAction,
      status: riskAction === 'BLOCK' ? 'BLOCKED' : 'ESCALATED',
      reasonCodes,
      explanation: `High risk level detected in AI contextual analysis (Merchant Risk: ${aiAnalysis.merchantRisk}, Anomaly Level: ${aiAnalysis.anomalyLevel}). Action: ${riskAction}.`,
      riskLevel: 'high',
      policyId: policy.policyId,
      requestId,
      paypalCallAllowed: false,
    };
  }

  // 8. ALLOW (Precedence 8)
  reasonCodes.push(REASON_CODES.POLICY_ALLOWED);
  return {
    decision: 'ALLOW',
    status: 'APPROVED',
    reasonCodes,
    explanation: `Payment request ($${amountVal} to "${paymentRequest.merchant.name}") passed all deterministic policy and safety checks.`,
    riskLevel: 'low',
    policyId: policy.policyId,
    requestId,
    paypalCallAllowed: true,
  };
}
