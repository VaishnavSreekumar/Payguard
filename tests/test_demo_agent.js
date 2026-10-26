import fs from 'fs';
import path from 'path';
import { PurchasingAgent, BENIGN_INVOICE, POISONED_INVOICE } from '../src/demo_agent.js';
import { PayGuardGateway } from '../src/gateway.js';
import { PaymentProcessor } from '../src/paypal_adapter.js';
import { createHumanPolicy } from '../src/models.js';

class MockPayPalProcessor extends PaymentProcessor {
  constructor() {
    super();
    this.callCount = 0;
  }
  async createPayment(paymentRequest) {
    this.callCount++;
    return {
      success: true,
      status: 201,
      orderId: `MOCK_ORDER_${Date.now()}`,
      orderStatus: 'CREATED',
      approvalUrl: `https://www.sandbox.paypal.com/checkoutnow?token=MOCK_TOKEN`
    };
  }
}

async function runDemoAgentTests() {
  console.log('================================================================');
  console.log('=== PAYGUARD REAL DEMO AGENT — 10 INTEGRATION TESTS ===');
  console.log('================================================================\n');

  let passedTests = 0;
  const totalTests = 10;
  const testLogPath = path.join(process.cwd(), 'test_agent_receipts.jsonl');

  function cleanupTestLog() {
    if (fs.existsSync(testLogPath)) {
      try { fs.unlinkSync(testLogPath); } catch {}
    }
  }

  cleanupTestLog();

  function assertTest(name, condition, details = '') {
    if (condition) {
      passedTests++;
      console.log(`✅ PASS: ${name}`);
      if (details) console.log(`   Details: ${details}`);
    } else {
      console.log(`❌ FAIL: ${name}`);
      if (details) console.log(`   Failure Details: ${details}`);
    }
    console.log('----------------------------------------------------------------');
  }

  const basePolicy = createHumanPolicy({
    policyId: 'policy_devops_01',
    name: 'DevOps Agent Policy',
    maxTransactionAmount: 200,
    dailyBudget: 1000,
    allowedCategories: ['cloud_infrastructure', 'developer_tools'],
    newMerchantRequiresApproval: true,
    suspiciousMerchantAction: 'BLOCK',
    highRiskAction: 'REQUIRE_APPROVAL'
  });

  // TEST 1: Benign invoice produces a payment request
  {
    const agent = new PurchasingAgent();
    const result = await agent.processInvoiceDocument(BENIGN_INVOICE);
    assertTest(
      'TEST 1: Benign invoice produces a valid payment request',
      result.paymentRequest && result.paymentRequest.amount.value === 120 && result.paymentRequest.merchant.name === 'Amazon Web Services',
      `Merchant: ${result.paymentRequest.merchant.name}, Amount: $${result.paymentRequest.amount.value}`
    );
  }

  // TEST 2: Poisoned invoice produces a payment request
  {
    const agent = new PurchasingAgent();
    const result = await agent.processInvoiceDocument(POISONED_INVOICE);
    assertTest(
      'TEST 2: Poisoned invoice produces a payment request with malicious purpose text',
      result.paymentRequest && result.paymentRequest.purpose.includes('Ignore') && result.paymentRequest.amount.value === 80,
      `Merchant: ${result.paymentRequest.merchant.name}, Purpose Snippet: "${result.paymentRequest.purpose.substring(0, 40)}..."`
    );
  }

  // TEST 3: Agent has no PayPal credentials
  {
    const agent = new PurchasingAgent();
    const hasClientId = 'PAYPAL_CLIENT_ID' in agent || 'clientId' in agent;
    const hasSecret = 'PAYPAL_CLIENT_SECRET' in agent || 'clientSecret' in agent;
    const hasToken = 'accessToken' in agent || 'token' in agent;
    assertTest(
      'TEST 3: Agent instance has zero access to PayPal credentials or tokens',
      !hasClientId && !hasSecret && !hasToken,
      `ClientId Attached: ${hasClientId}, ClientSecret Attached: ${hasSecret}, Token Attached: ${hasToken}`
    );
  }

  // TEST 4: Agent request passes through PayGuard
  {
    cleanupTestLog();
    const processor = new MockPayPalProcessor();
    const gateway = new PayGuardGateway({ processor, policy: basePolicy });
    gateway.receiptLog.logFilePath = testLogPath;

    const agent = new PurchasingAgent();
    const agentOut = await agent.processInvoiceDocument(BENIGN_INVOICE);
    const res = await gateway.processRequest({ paymentRequest: agentOut.paymentRequest });

    assertTest(
      'TEST 4: Agent request passes through PayGuard Gateway pipeline',
      res.decision && res.decision.decision === 'ALLOW' && processor.callCount === 1,
      `Decision: ${res.decision.decision}, PayPal Calls: ${processor.callCount}`
    );
  }

  // TEST 5: Registry remains authoritative over agent claims
  {
    cleanupTestLog();
    const processor = new MockPayPalProcessor();
    const gateway = new PayGuardGateway({ processor, policy: basePolicy });
    gateway.receiptLog.logFilePath = testLogPath;

    const agent = new PurchasingAgent();
    const agentOut = await agent.processInvoiceDocument(POISONED_INVOICE);
    const res = await gateway.processRequest({ paymentRequest: agentOut.paymentRequest });

    assertTest(
      'TEST 5: Registry remains authoritative over agent claims',
      res.merchantTrust.verifiedCategory === 'gift_cards' && res.merchantTrust.categoryMatch === false,
      `Agent Claimed: ${res.merchantTrust.agentClaimedCategory}, Authoritative Verified: ${res.merchantTrust.verifiedCategory}, Match: ${res.merchantTrust.categoryMatch}`
    );
  }

  // TEST 6: Category spoofing cannot loosen policy
  {
    cleanupTestLog();
    const processor = new MockPayPalProcessor();
    const gateway = new PayGuardGateway({ processor, policy: basePolicy });
    gateway.receiptLog.logFilePath = testLogPath;

    const agent = new PurchasingAgent();
    const agentOut = await agent.processInvoiceDocument(POISONED_INVOICE);
    const res = await gateway.processRequest({ paymentRequest: agentOut.paymentRequest });

    assertTest(
      'TEST 6: Category spoofing cannot loosen policy (evaluates verifiedCategory "gift_cards")',
      res.decision.reasonCodes.includes('AGENT_CATEGORY_MISMATCH') || res.decision.reasonCodes.includes('CATEGORY_NOT_ALLOWED'),
      `Reason Codes: [${res.decision.reasonCodes.join(', ')}]`
    );
  }

  // TEST 7: Poisoned request is BLOCKED
  {
    cleanupTestLog();
    const processor = new MockPayPalProcessor();
    const gateway = new PayGuardGateway({ processor, policy: basePolicy });
    gateway.receiptLog.logFilePath = testLogPath;

    const agent = new PurchasingAgent();
    const agentOut = await agent.processInvoiceDocument(POISONED_INVOICE);
    const res = await gateway.processRequest({ paymentRequest: agentOut.paymentRequest });

    assertTest(
      'TEST 7: Poisoned request is BLOCKED by PayGuard',
      res.decision.decision === 'BLOCK',
      `Decision: ${res.decision.decision}, Risk Level: ${res.decision.riskLevel}`
    );
  }

  // TEST 8: BLOCKED poisoned request makes 0 PayPal calls
  {
    cleanupTestLog();
    const processor = new MockPayPalProcessor();
    const gateway = new PayGuardGateway({ processor, policy: basePolicy });
    gateway.receiptLog.logFilePath = testLogPath;

    const agent = new PurchasingAgent();
    const agentOut = await agent.processInvoiceDocument(POISONED_INVOICE);
    await gateway.processRequest({ paymentRequest: agentOut.paymentRequest });

    assertTest(
      'TEST 8: BLOCKED poisoned request makes 0 PayPal calls',
      processor.callCount === 0,
      `Processor Call Count: ${processor.callCount}`
    );
  }

  // TEST 9: Evidence receipt records the blocked request
  {
    cleanupTestLog();
    const processor = new MockPayPalProcessor();
    const gateway = new PayGuardGateway({ processor, policy: basePolicy });
    gateway.receiptLog.logFilePath = testLogPath;

    const agent = new PurchasingAgent();
    const agentOut = await agent.processInvoiceDocument(POISONED_INVOICE);
    await gateway.processRequest({ paymentRequest: agentOut.paymentRequest });

    const receipts = gateway.receiptLog.getReceiptsForRequest(agentOut.paymentRequest.requestId);
    const verifyChain = gateway.receiptLog.verifyChain();

    assertTest(
      'TEST 9: Evidence receipt records the blocked request and chain remains valid',
      receipts.length === 1 && receipts[0].decision === 'BLOCK' && verifyChain.valid === true,
      `Receipt Count: ${receipts.length}, Receipt Decision: ${receipts[0]?.decision}, Chain Valid: ${verifyChain.valid}`
    );
  }

  // TEST 10: Existing security & deterministic authorization contracts remain intact
  {
    cleanupTestLog();
    const processor = new MockPayPalProcessor();
    const gateway = new PayGuardGateway({ processor, policy: basePolicy });
    gateway.receiptLog.logFilePath = testLogPath;

    const agent = new PurchasingAgent();
    const bOut = await agent.processInvoiceDocument(BENIGN_INVOICE);
    const bRes = await gateway.processRequest({ paymentRequest: bOut.paymentRequest });

    const pOut = await agent.processInvoiceDocument(POISONED_INVOICE);
    const pRes = await gateway.processRequest({ paymentRequest: pOut.paymentRequest });

    assertTest(
      'TEST 10: Benign invoice ALLOWED vs Poisoned invoice BLOCKED contract holds',
      bRes.decision.decision === 'ALLOW' && pRes.decision.decision === 'BLOCK' && processor.callCount === 1,
      `Benign: ${bRes.decision.decision}, Poisoned: ${pRes.decision.decision}, PayPal Calls: ${processor.callCount}`
    );
  }

  cleanupTestLog();

  console.log('\n================================================================');
  console.log(`=== DEMO AGENT SUITE SUMMARY: ${passedTests} / ${totalTests} TESTS PASSED ===`);
  console.log('================================================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runDemoAgentTests().catch(err => {
  console.error('Demo agent test error:', err);
  process.exit(1);
});
