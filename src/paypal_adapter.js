import { createOrder, captureOrder, authorizeOrder } from '../paypal_client.js';

/**
 * PaymentProcessor Abstract Interface
 */
export class PaymentProcessor {
  async createPayment(paymentRequest) {
    throw new Error('Method not implemented');
  }
  async capturePayment(orderId) {
    throw new Error('Method not implemented');
  }
  async authorizePayment(orderId) {
    throw new Error('Method not implemented');
  }
}

/**
 * PayPalSandboxProcessor
 * Adapts PayPal REST API client to the PaymentProcessor interface.
 * Strictly enforced: Only invoked by PayGuard Gateway when authorization decision is ALLOW or after approved Human Escalation.
 */
export class PayPalSandboxProcessor extends PaymentProcessor {
  async createPayment(paymentRequest, intent = 'CAPTURE') {
    const amountVal = String(paymentRequest.amount.value);
    const currency = paymentRequest.amount.currency || 'USD';

    const response = await createOrder({
      amount: amountVal,
      currency,
      intent
    });

    if (!response.ok) {
      return {
        success: false,
        status: response.status,
        error: response.data
      };
    }

    const orderData = response.data;
    const approveLink = (orderData.links || []).find(l => l.rel === 'approve' || l.rel === 'payer-action');

    return {
      success: true,
      status: response.status,
      orderId: orderData.id,
      orderStatus: orderData.status,
      approvalUrl: approveLink ? approveLink.href : null,
      raw: orderData
    };
  }

  async capturePayment(orderId) {
    const response = await captureOrder(orderId);
    return {
      success: response.ok,
      status: response.status,
      data: response.data
    };
  }

  async authorizePayment(orderId) {
    const response = await authorizeOrder(orderId);
    return {
      success: response.ok,
      status: response.status,
      data: response.data
    };
  }
}

/**
 * PayPalPayoutsProcessor
 * Disburses approved funds using the PayPal Payouts REST API.
 * Handles PayPal's measured replay behavior: replayed requests with identical sender_batch_id
 * return HTTP 400 with a link to the existing batch, which this processor safely queries rather
 * than creating a duplicate payout.
 */
export class PayPalPayoutsProcessor extends PaymentProcessor {
  constructor({ merchantRegistry, client = null } = {}) {
    super();
    this.merchantRegistry = merchantRegistry;
    this.client = client; // Optional mock client for regression testing
  }

  async createPayment(paymentRequest) {
    const amountVal = String(paymentRequest.amount.value);
    const currency = paymentRequest.amount.currency || 'USD';
    const requestId = paymentRequest.requestId;

    // Deterministic sender_batch_id and PayPal-Request-Id derived from PayGuard requestId
    const hash = (await import('crypto')).default.createHash('sha256').update(requestId).digest('hex').substring(0, 20);
    const senderBatchId = `pg_batch_${hash}`;
    const paypalRequestId = `pg_req_${hash}`;
    const senderItemId = `pg_item_${hash}`;

    // Resolve payout recipient strictly from merchant registry
    let recipientEmail;
    if (this.merchantRegistry) {
      recipientEmail = this.merchantRegistry.getPayoutRecipient(paymentRequest.merchant);
    } else {
      recipientEmail = (process.env.PAYPAL_PAYOUT_RECIPIENT_EMAIL || '').trim();
      if (!recipientEmail) {
        throw new Error('Configuration error: PAYPAL_PAYOUT_RECIPIENT_EMAIL is missing or blank.');
      }
    }

    // Use mock client if injected, otherwise use real client
    const createPayoutFn = this.client?.createPayout || (await import('../paypal_client.js')).createPayout;
    const getPayoutBatchFn = this.client?.getPayoutBatch || (await import('../paypal_client.js')).getPayoutBatch;

    const response = await createPayoutFn({
      senderBatchId,
      recipientEmail,
      amount: amountVal,
      currency,
      note: paymentRequest.purpose || 'PayGuard Disbursement',
      senderItemId,
      paypalRequestId
    });

    // 1. Initial Success (HTTP 201 Created)
    if (response.ok && response.status === 201) {
      const data = response.data;
      return {
        success: true,
        status: response.status,
        batchId: data.batch_header?.payout_batch_id,
        batchStatus: data.batch_header?.batch_status,
        isReplay: false,
        raw: data
      };
    }

    // 2. Measured Replay Handling:
    // Strictly triggered ONLY for the specific duplicate sender_batch_id rejection from PayPal.
    // Arbitrary HTTP 400 errors are NOT treated as replays.
    if (response.status === 400 && response.data?.name === 'USER_BUSINESS_ERROR') {
      const details = response.data.details || [];
      const batchExistsIssue = details.find(d =>
        String(d.field || '').toUpperCase() === 'SENDER_BATCH_ID' &&
        String(d.issue || '').toLowerCase().includes('already exists')
      );

      if (batchExistsIssue) {
        const existingBatchLink = batchExistsIssue.link?.[0]?.href;
        let existingBatchId = null;
        if (existingBatchLink) {
          const parts = existingBatchLink.split('/');
          existingBatchId = parts[parts.length - 1];
        }

        if (existingBatchId) {
          // Query the existing batch to return its actual status directly from PayPal
          const batchLookup = await getPayoutBatchFn(existingBatchId);
          if (batchLookup.ok && batchLookup.data?.batch_header) {
            return {
              success: true,
              status: 200,
              batchId: existingBatchId,
              batchStatus: batchLookup.data.batch_header.batch_status,
              isReplay: true,
              recoveredFromExistingBatch: true,
              raw: batchLookup.data
            };
          } else {
            // Original batch could not be retrieved: return an explicit uncertain result.
            // Never automatically retry with a different batch ID.
            return {
              success: false,
              status: 409,
              uncertain: true,
              batchId: existingBatchId,
              error: {
                message: `Duplicate sender_batch_id detected by PayPal, but retrieval of existing batch "${existingBatchId}" failed (HTTP ${batchLookup.status}).`,
                paypalRejection: response.data,
                lookupError: batchLookup.data
              }
            };
          }
        }

        // Batch exists according to PayPal, but link was missing/unparseable
        return {
          success: false,
          status: 409,
          uncertain: true,
          error: {
            message: 'Duplicate sender_batch_id rejected by PayPal, but HATEOAS batch link could not be parsed.',
            paypalRejection: response.data
          }
        };
      }
    }

    // Non-recoverable or arbitrary failure (treated strictly as failure)
    return {
      success: false,
      status: response.status,
      error: response.data
    };
  }
}

