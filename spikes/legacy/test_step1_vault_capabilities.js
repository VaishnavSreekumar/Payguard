import { getAccessToken, paypalRequest } from './paypal_client.js';

async function inspectVaultCapabilities() {
  console.log('=== TEST 1: INSPECT PAYPAL VAULT CAPABILITIES (RE-TEST) ===');
  
  try {
    const token = await getAccessToken();
    console.log('Fresh OAuth Access Token obtained.');

    // 1. Test POST /v3/vault/setup-tokens
    console.log('\n1. Testing POST /v3/vault/setup-tokens...');
    const setupTokenRes = await paypalRequest('/v3/vault/setup-tokens', {
      method: 'POST',
      body: JSON.stringify({
        payment_source: {
          paypal: {
            usage_type: 'MERCHANT',
            experience_context: {
              return_url: 'https://example.com/return',
              cancel_url: 'https://example.com/cancel',
            },
          },
        },
      }),
    });

    console.log(`Setup Tokens API HTTP Status: ${setupTokenRes.status}`);
    console.log('Setup Tokens Response:', JSON.stringify(setupTokenRes.data, null, 2));

    // 2. Test POST /v3/vault/payment-tokens
    console.log('\n2. Testing POST /v3/vault/payment-tokens...');
    const paymentTokenRes = await paypalRequest('/v3/vault/payment-tokens', {
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

    console.log(`Payment Tokens API HTTP Status: ${paymentTokenRes.status}`);
    console.log('Payment Tokens Response:', JSON.stringify(paymentTokenRes.data, null, 2));

    // 3. Test POST /v2/checkout/orders with vault attribute request
    console.log('\n3. Testing POST /v2/checkout/orders with vault attributes...');
    const orderVaultRes = await paypalRequest('/v2/checkout/orders', {
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
            attributes: {
              vault: {
                store_in_vault: 'ON_SUCCESS',
                usage_type: 'MERCHANT',
              },
            },
            experience_context: {
              return_url: 'https://example.com/return',
              cancel_url: 'https://example.com/cancel',
            },
          },
        },
      }),
    });

    console.log(`Orders v2 Vault Attributes HTTP Status: ${orderVaultRes.status}`);
    console.log('Orders v2 Vault Attributes Response:', JSON.stringify(orderVaultRes.data, null, 2));

  } catch (err) {
    console.error('Inspection error:', err);
  }
}

inspectVaultCapabilities();
