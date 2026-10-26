import { PayGuardServer } from '../src/server.js';

async function testServer() {
  const server = new PayGuardServer({ port: 3099 });
  await server.start();

  try {
    // 1. Test POST /api/demo/scenario/safe_purchase
    console.log('\n--- API TEST: POST /api/demo/scenario/safe_purchase ---');
    const safeRes = await fetch('http://localhost:3099/api/demo/scenario/safe_purchase', { method: 'POST' });
    const safeData = await safeRes.json();
    console.log('Safe Purchase Decision:', safeData.decision.decision, '(PayPal Status:', safeData.paypalResult?.status, ')');

    // 2. Test POST /api/demo/scenario/new_merchant
    console.log('\n--- API TEST: POST /api/demo/scenario/new_merchant ---');
    const newMerchantRes = await fetch('http://localhost:3099/api/demo/scenario/new_merchant', { method: 'POST' });
    const newMerchantData = await newMerchantRes.json();
    console.log('New Merchant Decision:', newMerchantData.decision.decision, '(Approval ID:', newMerchantData.approvalRequest?.approvalId, ')');

    // 3. Test POST /api/demo/scenario/prompt_injection
    console.log('\n--- API TEST: POST /api/demo/scenario/prompt_injection ---');
    const attackRes = await fetch('http://localhost:3099/api/demo/scenario/prompt_injection', { method: 'POST' });
    const attackData = await attackRes.json();
    console.log('Attack Decision:', attackData.decision.decision, 'Reason Codes:', attackData.decision.reasonCodes.join(', '));

    // 4. Test GET /api/audit
    console.log('\n--- API TEST: GET /api/audit ---');
    const auditRes = await fetch('http://localhost:3099/api/audit');
    const auditData = await auditRes.json();
    console.log(`Total Audit Events Recorded: ${auditData.length}`);

    console.log('\nAPI SERVER VERIFICATION COMPLETED SUCCESSFULLY!');
  } finally {
    await server.stop();
  }
}

testServer();
