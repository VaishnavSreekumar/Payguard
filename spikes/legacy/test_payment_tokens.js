import { paypalRequest } from './paypal_client.js';

async function testPaymentTokensEndpoint() {
  console.log('Testing POST /v3/vault/payment-tokens...');
  const res = await paypalRequest('/v3/vault/payment-tokens', {
    method: 'POST',
    body: JSON.stringify({
      payment_source: {
        token: {
          id: 'TEST_TOKEN',
          type: 'SETUP_TOKEN',
        },
      },
    }),
  });

  console.log(`Payment Tokens API HTTP Status: ${res.status}`);
  console.log('Payment Tokens Response:', JSON.stringify(res.data, null, 2));
}

testPaymentTokensEndpoint();
