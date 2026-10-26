import { paypalRequest } from './paypal_client.js';

async function testOrdersWithVaultToken() {
  console.log('Testing POST /v2/checkout/orders with payment_source.token...');
  const res1 = await paypalRequest('/v2/checkout/orders', {
    method: 'POST',
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: {
            currency_code: 'USD',
            value: '5.00',
          },
        },
      ],
      payment_source: {
        token: {
          id: 'SAMPLE_VAULT_TOKEN_123',
          type: 'PAYMENT_METHOD_TOKEN',
        },
      },
    }),
  });

  console.log(`Orders v2 payment_source.token HTTP Status: ${res1.status}`);
  console.log('Orders v2 payment_source.token Response:', JSON.stringify(res1.data, null, 2));

  console.log('\nTesting POST /v2/checkout/orders with payment_source.vault_id...');
  const res2 = await paypalRequest('/v2/checkout/orders', {
    method: 'POST',
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: {
            currency_code: 'USD',
            value: '5.00',
          },
        },
      ],
      payment_source: {
        vault_id: 'SAMPLE_VAULT_ID_123',
      },
    }),
  });

  console.log(`Orders v2 payment_source.vault_id HTTP Status: ${res2.status}`);
  console.log('Orders v2 payment_source.vault_id Response:', JSON.stringify(res2.data, null, 2));
}

testOrdersWithVaultToken();
