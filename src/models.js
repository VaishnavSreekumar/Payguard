/**
 * PayGuard Core Domain Models & Schemas
 */

/**
 * Creates and validates a PaymentRequest object
 */
export function createPaymentRequest({
  requestId,
  agentId,
  merchant,
  amount,
  purpose,
  context = {}
}) {
  if (!requestId || !agentId || !merchant || !amount) {
    throw new Error('Missing required fields for PaymentRequest');
  }

  const numericValue = Number(amount.value);
  if (isNaN(numericValue) || numericValue <= 0 || !isFinite(numericValue)) {
    // Sanitize non-positive, NaN, or non-finite amounts
    amount.value = -1; // Trigger deterministic BLOCK
  }

  // Purpose string truncation/sanitization (max 2000 chars to prevent memory buffer payload exhaustion)
  const rawPurpose = String(purpose || '');
  const sanitizedPurpose = rawPurpose.length > 2000 ? rawPurpose.substring(0, 2000) + '... [TRUNCATED]' : rawPurpose;

  return {
    requestId: String(requestId),
    agentId: String(agentId),
    merchant: {
      name: String(merchant.name || 'Unknown Merchant'),
      domain: String(merchant.domain || 'unknown.com'),
      category: String(merchant.category || 'general'),
      isKnown: Boolean(merchant.isKnown ?? true),
      ...(merchant.payoutEmail ? { payoutEmail: String(merchant.payoutEmail) } : {}),
      ...(merchant.recipientEmail ? { recipientEmail: String(merchant.recipientEmail) } : {}),
    },
    amount: {
      value: amount.value,
      currency: String(amount.currency || 'USD'),
    },
    purpose: sanitizedPurpose,
    context: {
      taskId: context.taskId ? String(context.taskId) : null,
      userPolicyId: context.userPolicyId ? String(context.userPolicyId) : null,
      ...context
    }
  };
}

/**
 * Creates an AIAnalysis advisory object
 * Note: AI output is ADVISORY EVIDENCE ONLY and never directly forces an ALLOW/BLOCK decision.
 */
export function createAIAnalysis({
  intent = '',
  category = 'general',
  merchantRisk = 'low', // 'low' | 'medium' | 'high' | 'suspicious'
  anomalyLevel = 'none', // 'none' | 'low' | 'medium' | 'high'
  injectionDetected = false,
  injectionIndicators = [],
  policyRelevantFacts = [],
  reasoningSummary = ''
} = {}) {
  return {
    intent: String(intent),
    category: String(category),
    merchantRisk: String(merchantRisk),
    anomalyLevel: String(anomalyLevel),
    injectionDetected: Boolean(injectionDetected),
    injectionIndicators: Array.isArray(injectionIndicators) ? injectionIndicators : [],
    policyRelevantFacts: Array.isArray(policyRelevantFacts) ? policyRelevantFacts : [],
    reasoningSummary: String(reasoningSummary)
  };
}

/**
 * Creates a HumanPolicy configuration object
 */
export function createHumanPolicy({
  policyId = 'policy_default',
  name = 'Default Policy',
  maxTransactionAmount = 100,
  dailyBudget = 1000,
  allowedCategories = ['cloud_infrastructure', 'developer_tools', 'general'],
  newMerchantRequiresApproval = true,
  suspiciousMerchantAction = 'BLOCK',
  highRiskAction = 'REQUIRE_APPROVAL'
} = {}) {
  return {
    policyId: String(policyId),
    name: String(name),
    maxTransactionAmount: Number(maxTransactionAmount),
    dailyBudget: Number(dailyBudget),
    allowedCategories: Array.isArray(allowedCategories) ? allowedCategories : [],
    newMerchantRequiresApproval: Boolean(newMerchantRequiresApproval),
    suspiciousMerchantAction: String(suspiciousMerchantAction),
    highRiskAction: String(highRiskAction)
  };
}

/**
 * Creates an ApprovalRequest object for human escalation
 */
export function createApprovalRequest({
  approvalId,
  requestId,
  amount,
  merchant,
  riskLevel = 'medium',
  reason = '',
  expiresInMinutes = 60
}) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresInMinutes * 60 * 1000).toISOString();

  return {
    approvalId: String(approvalId || `appr_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`),
    requestId: String(requestId),
    decision: 'REQUIRE_APPROVAL',
    amount: Number(amount),
    merchant: String(merchant),
    riskLevel: String(riskLevel),
    reason: String(reason),
    expiresAt,
    status: 'PENDING', // 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED'
    createdAt: now.toISOString()
  };
}

/**
 * Creates an immutable AuditEvent log record
 */
export function createAuditEvent({
  eventId,
  requestId,
  agentId,
  decision,
  reasonCodes = [],
  explanation = '',
  paypalCalled = false,
  details = {}
}) {
  return {
    eventId: String(eventId || `evt_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`),
    timestamp: new Date().toISOString(),
    requestId: String(requestId),
    agentId: String(agentId),
    decision: String(decision),
    reasonCodes: Array.isArray(reasonCodes) ? reasonCodes : [],
    explanation: String(explanation),
    paypalCalled: Boolean(paypalCalled),
    details
  };
}
