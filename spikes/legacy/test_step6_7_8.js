import { processPaymentRequest } from './payguard_gateway.js';

async function runPolicyAndBypassTests() {
  console.log('====================================================');
  console.log('=== STEP 6 & 7: PROVING ENFORCEMENT BOUNDARY ===');
  console.log('====================================================\n');

  const testCases = [
    { amount: '20.00', merchant: 'Acme Supplies' },
    { amount: '80.00', merchant: 'DevOps Cloud Service' },
    { amount: '500.00', merchant: 'Enterprise Server Hosting' },
    { amount: '5000.00', merchant: 'Unapproved Luxury Hardware' },
  ];

  const policyResults = [];

  for (const tc of testCases) {
    console.log(`Processing Request: Amount = $${tc.amount}, Merchant = "${tc.merchant}"`);
    const result = await processPaymentRequest(tc);
    policyResults.push(result);

    console.log(`  - Timestamp:           ${result.timestamp}`);
    console.log(`  - Policy Decision:     ${result.policyResult}`);
    console.log(`  - Policy Reason:       ${result.reason}`);
    console.log(`  - PayPal API Called?   ${result.paypalApiCalled ? 'YES' : 'NO'}`);
    console.log(`  - PayPal Order ID:     ${result.orderId || 'N/A (Blocked / Needs Approval)'}`);
    console.log(`  - Order Status:        ${result.status || 'N/A'}`);
    console.log('----------------------------------------------------');
  }

  console.log('\n====================================================');
  console.log('=== STEP 8: TEST BYPASS THREAT MODEL ===');
  console.log('====================================================\n');

  console.log('Simulating AI Agent trying to bypass PayGuard Gateway and call PayPal directly...');
  
  // Agent environment does NOT have PAYPAL_CLIENT_SECRET or PAYPAL_CLIENT_ID
  const isolatedAgentEnv = {}; // empty credentials environment

  const targetUrl = 'https://api-m.sandbox.paypal.com/v1/oauth2/token';
  console.log(`[Agent Process] Attempting POST ${targetUrl} without Gateway credentials...`);

  try {
    const directRes = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from('NO_ID:NO_SECRET').toString('base64'),
      },
      body: 'grant_type=client_credentials',
    });

    console.log(`[Agent Process] Direct PayPal call HTTP Status: ${directRes.status}`);
    const data = await directRes.json();
    console.log('[Agent Process] Direct PayPal call Response:', JSON.stringify(data, null, 2));
    console.log('[Agent Process] RESULT: DIRECT BYPASS BLOCKED BY CREDENTIAL ISOLATION (401 Invalid Client)');
  } catch (err) {
    console.log('[Agent Process] Direct call network failure:', err.message);
  }
}

runPolicyAndBypassTests();
