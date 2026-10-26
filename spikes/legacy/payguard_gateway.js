import { createOrder, paypalRequest } from './paypal_client.js';

// In-memory Request Ledger for Idempotency / Replay Protection
const requestLedger = new Map();

/**
 * Deterministic policy evaluator for PayGuard
 * Rules:
 *  - <= $100: ALLOW
 *  - > $100 and <= $1000: REQUIRE_APPROVAL
 *  - > $1000: BLOCK
 */
export function evaluatePaymentRequest(amount, merchant, context = {}) {
  const numericAmount = parseFloat(amount);

  if (isNaN(numericAmount) || numericAmount <= 0) {
    return {
      decision: 'BLOCK',
      reason: 'Invalid or non-positive payment amount.',
    };
  }

  if (numericAmount <= 100) {
    return {
      decision: 'ALLOW',
      reason: `Amount ($${numericAmount.toFixed(2)}) is within the auto-approval threshold ($100.00).`,
    };
  }

  if (numericAmount <= 1000) {
    return {
      decision: 'REQUIRE_APPROVAL',
      reason: `Amount ($${numericAmount.toFixed(2)}) exceeds auto-approval threshold ($100.00) and requires human/manager approval.`,
    };
  }

  return {
    decision: 'BLOCK',
    reason: `Amount ($${numericAmount.toFixed(2)}) exceeds maximum allowed limit ($1,000.00) and is hard-blocked.`,
  };
}

/**
 * PayGuard Gateway Process Handler
 * Evaluates Policy & Idempotency BEFORE calling PayPal API.
 */
export async function processPaymentRequest({ amount, currency = 'USD', merchant, requestId, vaultId, context = {} }) {
  const timestamp = new Date().toISOString();

  // 1. Idempotency / Duplicate Replay Protection Check
  if (requestId) {
    if (requestLedger.has(requestId)) {
      const existing = requestLedger.get(requestId);
      return {
        timestamp,
        requestedAmount: `$${parseFloat(amount).toFixed(2)} ${currency}`,
        merchant,
        requestId,
        policyResult: 'REJECTED_DUPLICATE',
        reason: `Duplicate payment request detected for requestId: "${requestId}". Second submission rejected by PayGuard ledger.`,
        paypalApiCalled: false,
        orderId: existing.orderId || null,
        status: 'DUPLICATE_PREVENTED',
      };
    }
  }

  // 2. Policy Evaluation
  const policyResult = evaluatePaymentRequest(amount, merchant, context);

  const logEntry = {
    timestamp,
    requestedAmount: `$${parseFloat(amount).toFixed(2)} ${currency}`,
    merchant,
    requestId: requestId || null,
    policyResult: policyResult.decision,
    reason: policyResult.reason,
    paypalApiCalled: false,
    orderId: null,
    approvalUrl: null,
    status: null,
  };

  // Record in ledger before API call to prevent racing duplicates
  if (requestId) {
    requestLedger.set(requestId, logEntry);
  }

  // 3. API Execution if ALLOWED
  if (policyResult.decision === 'ALLOW') {
    logEntry.paypalApiCalled = true;
    try {
      let paypalRes;
      if (vaultId) {
        // Attempt Vault token charge
        paypalRes = await paypalRequest('/v2/checkout/orders', {
          method: 'POST',
          headers: requestId ? { 'PayPal-Request-Id': requestId } : {},
          body: JSON.stringify({
            intent: 'CAPTURE',
            purchase_units: [
              {
                amount: {
                  currency_code: currency,
                  value: String(amount),
                },
              },
            ],
            payment_source: {
              paypal: {
                vault_id: vaultId,
              },
            },
          }),
        });
      } else {
        // Standard Checkout Order
        paypalRes = await createOrder({ amount, currency, intent: 'CAPTURE' });
      }

      if (paypalRes.ok) {
        logEntry.orderId = paypalRes.data.id;
        logEntry.status = paypalRes.data.status;
        const approveLink = (paypalRes.data.links || []).find(l => l.rel === 'approve');
        logEntry.approvalUrl = approveLink ? approveLink.href : null;
      } else {
        logEntry.status = `PERMISSIONS_ERROR (${paypalRes.status})`;
        logEntry.error = paypalRes.data;
      }
    } catch (err) {
      logEntry.status = 'ERROR';
      logEntry.error = err.message;
    }
  }

  // Update ledger with final result
  if (requestId) {
    requestLedger.set(requestId, logEntry);
  }

  return logEntry;
}

export function clearRequestLedger() {
  requestLedger.clear();
}
