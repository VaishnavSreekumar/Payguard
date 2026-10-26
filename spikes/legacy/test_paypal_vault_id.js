import { paypalRequest } from './paypal_client.js';

async function testPaypalVaultId() {
  console.log('Testing POST /v2/checkout/orders with payment_source.paypal.vault_id...');
  const res = await paypalRequest('/v2/checkout/orders', {
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
        paypal: {
          vault_id: 'SAMPLE_VAULT_ID_123',
        },
      },
    }),
  });

  console.log(`Orders v2 payment_source.paypal.vault_id HTTP Status: ${res.status}`);
  console.log('Orders v2 payment_source.paypal.vault_id Response:', JSON.stringify(res.data, null, 2));
}

testPaypalVaultId();
