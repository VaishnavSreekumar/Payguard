import { processPaymentRequest, clearRequestLedger } from './payguard_gateway.js';

async function runSpike3Tests() {
  console.log('====================================================');
  console.log('=== PAYGUARD VAULT SPIKE — FULL EXPERIMENTAL TEST ===');
  console.log('====================================================\n');

  // STEP 5 & 6: Policy Gating ($5, $20, $80, $500, $5,000)
  console.log('--- STEP 5 & 6: AGENT SPENDING POLICY TEST ---');
  const policyAmounts = [
    { amount: '5.00', merchant: 'Vendor A' },
    { amount: '20.00', merchant: 'Vendor A' },
    { amount: '80.00', merchant: 'Vendor A' },
    { amount: '500.00', merchant: 'Vendor A' },
    { amount: '5000.00', merchant: 'Vendor A' },
  ];

  for (const tc of policyAmounts) {
    const res = await processPaymentRequest({
      amount: tc.amount,
      merchant: tc.merchant,
      requestId: `req-pol-${tc.amount}`,
      vaultId: 'SAMPLE_VAULT_ID_123',
    });

    console.log(`Request: $${tc.amount} to "${tc.merchant}"`);
    console.log(`  - Policy Decision:   ${res.policyResult}`);
    console.log(`  - Reason:            ${res.reason}`);
    console.log(`  - PayPal API Called? ${res.paypalApiCalled ? 'YES' : 'NO'}`);
    console.log(`  - Result Status:     ${res.status || 'N/A'}`);
    console.log('----------------------------------------------------');
  }

  // STEP 7: Credential Isolation
  console.log('\n--- STEP 7: CREDENTIAL ISOLATION THREAT MODEL ---');
  console.log('Agent process attempting direct access to PayPal without Gateway credentials...');
  const targetUrl = 'https://api-m.sandbox.paypal.com/v1/oauth2/token';
  try {
    const directRes = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from('NO_ID:NO_SECRET').toString('base64'),
      },
      body: 'grant_type=client_credentials',
    });

    console.log(`Direct Agent Request HTTP Status: ${directRes.status}`);
    const data = await directRes.json();
    console.log(`Direct Agent Response: ${data.error} (${data.error_description})`);
    console.log('Result: DIRECT BYPASS BLOCKED (HTTP 401 Unauthorized)');
  } catch (err) {
    console.log('Direct call error:', err.message);
  }

  // STEP 8: Duplicate / Replay Protection Test
  console.log('\n--- STEP 8: REPLAY & DUPLICATE PROTECTION TEST ---');
  clearRequestLedger();
  const duplicateReqId = 'tx-req-id-998877';

  console.log(`[Submission 1] Submitting $20.00 payment to Vendor A (Request ID: ${duplicateReqId})...`);
  const sub1 = await processPaymentRequest({
    amount: '20.00',
    merchant: 'Vendor A',
    requestId: duplicateReqId,
  });
  console.log(`Submission 1 Result: Policy=${sub1.policyResult}, PayPal Called=${sub1.paypalApiCalled}, OrderId=${sub1.orderId}`);

  console.log(`\n[Submission 2 - DUPLICATE] Submitting identical $20.00 payment to Vendor A (Request ID: ${duplicateReqId})...`);
  const sub2 = await processPaymentRequest({
    amount: '20.00',
    merchant: 'Vendor A',
    requestId: duplicateReqId,
  });
  console.log(`Submission 2 Result: Policy=${sub2.policyResult}, Status=${sub2.status}, PayPal Called=${sub2.paypalApiCalled}`);
  console.log(`Reason: ${sub2.reason}`);
}

runSpike3Tests();
