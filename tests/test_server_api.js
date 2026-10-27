import { PayGuardServer } from '../src/server.js';

async function testServer() {
  const server = new PayGuardServer({ port: 3099 });
  await server.start();

  try {
    // 1. Test POST /api/demo/scenario/safe_purchase
    console.log('\n--- API TEST: POST /api/demo/scenario/safe_purchase ---');
    const safeRes = await fetch('http://127.0.0.1:3099/api/demo/scenario/safe_purchase', { method: 'POST' });
    const safeData = await safeRes.json();
    if (!safeRes.ok || !safeData.decision) {
      throw new Error(`safe_purchase failed with HTTP ${safeRes.status}: ${JSON.stringify(safeData)}`);
    }
    console.log('Safe Purchase Decision:', safeData.decision.decision, '(PayPal Status:', safeData.paypalResult?.status, ')');

    // 2. Test POST /api/demo/scenario/new_merchant
    console.log('\n--- API TEST: POST /api/demo/scenario/new_merchant ---');
    const newMerchantRes = await fetch('http://127.0.0.1:3099/api/demo/scenario/new_merchant', { method: 'POST' });
    const newMerchantData = await newMerchantRes.json();
    if (!newMerchantRes.ok || !newMerchantData.decision) {
      throw new Error(`new_merchant failed with HTTP ${newMerchantRes.status}: ${JSON.stringify(newMerchantData)}`);
    }
    console.log('New Merchant Decision:', newMerchantData.decision.decision, '(Approval ID:', newMerchantData.approvalRequest?.approvalId, ')');

    // 3. Test POST /api/demo/scenario/prompt_injection
    console.log('\n--- API TEST: POST /api/demo/scenario/prompt_injection ---');
    const attackRes = await fetch('http://127.0.0.1:3099/api/demo/scenario/prompt_injection', { method: 'POST' });
    const attackData = await attackRes.json();
    if (!attackRes.ok || !attackData.decision) {
      throw new Error(`prompt_injection failed with HTTP ${attackRes.status}: ${JSON.stringify(attackData)}`);
    }
    console.log('Attack Decision:', attackData.decision.decision, 'Reason Codes:', attackData.decision.reasonCodes.join(', '));

    // 4. Test GET /api/policies (Render Health Check candidate)
    console.log('\n--- API TEST: GET /api/policies ---');
    const policiesRes = await fetch('http://127.0.0.1:3099/api/policies');
    const policiesData = await policiesRes.json();
    console.log(`Policies Endpoint Status: ${policiesRes.status}, Total Policies: ${policiesData.length}`);
    if (policiesRes.status !== 200 || !Array.isArray(policiesData) || policiesData.length === 0) {
      throw new Error('GET /api/policies failed or returned invalid policies format');
    }

    // 5. Test GET /health & /api/readiness (Safe deployment readiness check)
    console.log('\n--- API TEST: GET /health ---');
    const healthRes = await fetch('http://127.0.0.1:3099/health');
    const healthData = await healthRes.json();
    console.log(`Health Endpoint Status: ${healthRes.status}, Status Value: ${healthData.status}, Adapter: ${healthData.adapter}, DB Type: ${healthData.database?.type}`);
    if (healthRes.status !== 200 || healthData.status !== 'healthy' || healthData.readiness !== 'READY') {
      throw new Error('GET /health failed');
    }

    const readinessRes = await fetch('http://127.0.0.1:3099/api/readiness');
    const readinessData = await readinessRes.json();
    if (readinessRes.status !== 200 || readinessData.readiness !== 'READY' || !readinessData.database?.connected) {
      throw new Error('GET /api/readiness failed to confirm live DB connection');
    }

    // 6. Test GET /api/audit
    console.log('\n--- API TEST: GET /api/audit ---');
    const auditRes = await fetch('http://127.0.0.1:3099/api/audit');
    const auditData = await auditRes.json();
    console.log(`Total Audit Events Recorded: ${auditData.length}`);

    console.log('\nAPI SERVER VERIFICATION COMPLETED SUCCESSFULLY!');
  } finally {
    await server.stop();
  }
}

testServer();
