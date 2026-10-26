import { getAccessToken, paypalRequest } from '../paypal_client.js';

async function runSpikes() {
  console.log('====================================================');
  console.log('=== STEP 0: PAYPAL SANDBOX CAPABILITY SPIKES ===');
  console.log('====================================================\n');

  const token = await getAccessToken();
  console.log('OAuth Token successfully obtained.');

  // ----------------------------------------------------
  // SPIKE A: Payouts API
  // ----------------------------------------------------
  console.log('\n--- SPIKE A: Payouts API (POST /v1/payments/payouts) ---');
  const payoutBatchId = `batch_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const payoutPayload = {
    sender_batch_header: {
      sender_batch_id: payoutBatchId,
      email_subject: 'PayGuard Agent Payout Verification',
      email_message: 'Automated test payout from PayGuard agent settlement spike.'
    },
    items: [
      {
        recipient_type: 'EMAIL',
        amount: {
          value: '5.00',
          currency: 'USD'
        },
        note: 'Test payout for autonomous agent work verification',
        sender_item_id: `item_${Date.now()}`,
        receiver: 'sb-buyer-test@business.example.com' // standard sandbox format
      }
    ]
  };

  try {
    const payoutRes = await paypalRequest('/v1/payments/payouts', {
      method: 'POST',
      body: JSON.stringify(payoutPayload)
    });
    console.log(`Payouts API HTTP Status: ${payoutRes.status}`);
    console.log('Payouts Response Body:', JSON.stringify(payoutRes.data, null, 2));
  } catch (err) {
    console.error('Payouts Request Exception:', err.message);
  }

  // ----------------------------------------------------
  // SPIKE B: Orders AUTHORIZE flow
  // ----------------------------------------------------
  console.log('\n--- SPIKE B: Orders AUTHORIZE Flow ---');
  const orderPayload = {
    intent: 'AUTHORIZE',
    purchase_units: [
      {
        reference_id: `auth_unit_${Date.now()}`,
        amount: {
          currency_code: 'USD',
          value: '15.00'
        },
        description: 'PayGuard Agent Authorized Cloud Work Order'
      }
    ],
    application_context: {
      return_url: 'https://example.com/payguard/return',
      cancel_url: 'https://example.com/payguard/cancel',
      user_action: 'CONTINUE'
    }
  };

  let createdOrderId = null;
  let approveUrl = null;

  try {
    const orderRes = await paypalRequest('/v2/checkout/orders', {
      method: 'POST',
      headers: {
        'Prefer': 'return=representation',
        'PayPal-Request-Id': `req_auth_${Date.now()}`
      },
      body: JSON.stringify(orderPayload)
    });
    console.log(`Orders AUTHORIZE Create HTTP Status: ${orderRes.status}`);
    console.log('Orders AUTHORIZE Response Body:', JSON.stringify(orderRes.data, null, 2));

    if (orderRes.ok && orderRes.data?.id) {
      createdOrderId = orderRes.data.id;
      const links = orderRes.data.links || [];
      const approveLink = links.find(l => l.rel === 'approve' || l.rel === 'payer-action');
      approveUrl = approveLink ? approveLink.href : null;
      console.log(`Created Order ID: ${createdOrderId}`);
      console.log(`Payer Approval URL: ${approveUrl}`);

      // Now test: what happens if we attempt to authorize before buyer approval?
      console.log('\nAttempting POST /v2/checkout/orders/{id}/authorize before buyer approval...');
      const preAuthRes = await paypalRequest(`/v2/checkout/orders/${createdOrderId}/authorize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        }
      });
      console.log(`Pre-approval Authorize HTTP Status: ${preAuthRes.status}`);
      console.log('Pre-approval Authorize Response:', JSON.stringify(preAuthRes.data, null, 2));
    }
  } catch (err) {
    console.error('Orders Authorize Exception:', err.message);
  }

  // ----------------------------------------------------
  // SPIKE C: Webhooks Management & Verification
  // ----------------------------------------------------
  console.log('\n--- SPIKE C: Webhooks API Check ---');
  try {
    // 1. List existing webhooks
    const listWebhooks = await paypalRequest('/v1/notifications/webhooks', {
      method: 'GET'
    });
    console.log(`List Webhooks HTTP Status: ${listWebhooks.status}`);
    console.log('List Webhooks Response:', JSON.stringify(listWebhooks.data, null, 2));

    // 2. Test verify-webhook-signature schema check
    console.log('\nTesting POST /v1/notifications/verify-webhook-signature endpoint accessibility...');
    const verifyPayload = {
      auth_algo: 'SHA256withRSA',
      cert_url: 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2-4f6e-9ab0-55b1ac5374fb',
      transmission_id: 'test-transmission-id',
      transmission_sig: 'test-transmission-sig',
      transmission_time: new Date().toISOString(),
      webhook_id: 'WH-00000000000000000',
      webhook_event: {
        id: 'WH-EVENT-TEST',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource_type: 'capture',
        summary: 'Payment capture completed',
        resource: { id: 'CAP-TEST' }
      }
    };

    const verifyRes = await paypalRequest('/v1/notifications/verify-webhook-signature', {
      method: 'POST',
      body: JSON.stringify(verifyPayload)
    });
    console.log(`Verify Signature Endpoint HTTP Status: ${verifyRes.status}`);
    console.log('Verify Signature Endpoint Response:', JSON.stringify(verifyRes.data, null, 2));
  } catch (err) {
    console.error('Webhooks Spike Exception:', err.message);
  }

  console.log('\n====================================================');
  console.log('=== SPIKES EXECUTION FINISHED ===');
  console.log('====================================================');
}

runSpikes();
