import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { PayGuardGateway } from '../src/gateway.js';
import { generateKeyPair, createSpendingMandate, verifyMandate } from '../src/mandate.js';
import { createPaymentRequest, createHumanPolicy } from '../src/models.js';
import { PaymentProcessor } from '../src/paypal_adapter.js';

class MockProcessor extends PaymentProcessor {
  constructor() {
    super();
    this.calls = [];
  }
  async createPayment(req) {
    this.calls.push(req);
    return { success: true, status: 201, batchId: 'BATCH_TEST_101', batchStatus: 'SUCCESS' };
  }
}

async function runKeySeparationTests() {
  console.log('================================================================');
  console.log('=== PAYGUARD CRYPTOGRAPHIC KEY SEPARATION TEST SUITE         ===');
  console.log('================================================================\n');

  let passedTests = 0;
  const totalTests = 7;

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

  const testPolicy = createHumanPolicy({
    policyId: 'policy_prod_admin_01',
    maxTransactionAmount: 200,
    dailyBudget: 1000,
    allowedCategories: ['cloud_infrastructure', 'developer_tools'],
    newMerchantRequiresApproval: true
  });

  // Admin keypair (offline)
  const adminKeys = generateKeyPair();

  // Gateway keypair (runtime)
  const gatewayKeys = generateKeyPair();

  // Helper payment request
  function getSampleRequest(id) {
    return createPaymentRequest({
      requestId: id,
      agentId: 'agent_devops_01',
      merchant: { name: 'AWS', domain: 'aws.amazon.com', category: 'cloud_infrastructure' },
      amount: { value: 65, currency: 'USD' },
      purpose: 'Server hosting'
    });
  }

  // ----------------------------------------------------------------
  // TEST 1: Valid mandate signed by configured admin key is accepted
  // ----------------------------------------------------------------
  const validMandate = createSpendingMandate({
    policy: testPolicy,
    authorityName: 'Admin SecOps',
    expiresInDays: 30,
    privateKey: adminKeys.privateKey
  });

  const proc1 = new MockProcessor();
  const gateway1 = new PayGuardGateway({
    processor: proc1,
    adminPublicKey: adminKeys.publicKey,
    gatewayPrivateKey: gatewayKeys.privateKey,
    spendingMandate: validMandate,
    policy: testPolicy
  });

  const res1 = await gateway1.processRequest({ paymentRequest: getSampleRequest('req_ks_01') });

  assertTest(
    '1. Valid mandate signed by configured admin key is accepted',
    res1.decision.decision === 'ALLOW' && proc1.calls.length === 1,
    `Decision: ${res1.decision.decision}, Processor Calls: ${proc1.calls.length}`
  );

  // ----------------------------------------------------------------
  // TEST 2: Mandate signed by a different private key is rejected
  // ----------------------------------------------------------------
  const rogueAdminKeys = generateKeyPair();
  const rogueMandate = createSpendingMandate({
    policy: testPolicy,
    authorityName: 'Impostor Admin',
    expiresInDays: 30,
    privateKey: rogueAdminKeys.privateKey
  });

  const proc2 = new MockProcessor();
  const gateway2 = new PayGuardGateway({
    processor: proc2,
    adminPublicKey: adminKeys.publicKey, // Configured with legitimate admin key
    gatewayPrivateKey: gatewayKeys.privateKey,
    spendingMandate: rogueMandate, // Mandate signed by rogue key
    policy: testPolicy
  });

  const res2 = await gateway2.processRequest({ paymentRequest: getSampleRequest('req_ks_02') });

  assertTest(
    '2. Mandate signed by a different private key is rejected',
    res2.decision.decision === 'BLOCK' &&
    res2.decision.reasonCodes.includes('MANDATE_INVALID') &&
    proc2.calls.length === 0,
    `Decision: ${res2.decision.decision}, Reasons: [${res2.decision.reasonCodes.join(', ')}], Processor Calls: ${proc2.calls.length}`
  );

  // ----------------------------------------------------------------
  // TEST 3: Attacker embedded public key cannot establish trust
  // ----------------------------------------------------------------
  const attackerKeys = generateKeyPair();
  const attackerMandate = createSpendingMandate({
    policy: {
      ...testPolicy,
      maxTransactionAmount: 999999, // Attacker inflated limit
      dailyBudget: 999999
    },
    authorityName: 'Attacker Authority',
    expiresInDays: 30,
    privateKey: attackerKeys.privateKey
  });
  // The attacker mandate includes the attacker's own public key in metadata
  attackerMandate.publicKey = attackerKeys.publicKey;

  const proc3 = new MockProcessor();
  const gateway3 = new PayGuardGateway({
    processor: proc3,
    adminPublicKey: adminKeys.publicKey, // Trusted admin key remains authoritative
    gatewayPrivateKey: gatewayKeys.privateKey,
    spendingMandate: attackerMandate,
    policy: testPolicy
  });

  const res3 = await gateway3.processRequest({ paymentRequest: getSampleRequest('req_ks_03') });

  assertTest(
    '3. Attacker embedded public key cannot establish trust or override configured key',
    res3.decision.decision === 'BLOCK' &&
    res3.decision.reasonCodes.includes('MANDATE_INVALID') &&
    proc3.calls.length === 0,
    `Decision: ${res3.decision.decision}, Reasons: [${res3.decision.reasonCodes.join(', ')}], Processor Calls: ${proc3.calls.length}`
  );

  // ----------------------------------------------------------------
  // TEST 4: Tampering with signed mandate contents causes rejection
  // ----------------------------------------------------------------
  const tamperedMandate = JSON.parse(JSON.stringify(validMandate));
  tamperedMandate.policy.maxTransactionAmount = 5000; // Alter policy after signature

  const proc4 = new MockProcessor();
  const gateway4 = new PayGuardGateway({
    processor: proc4,
    adminPublicKey: adminKeys.publicKey,
    gatewayPrivateKey: gatewayKeys.privateKey,
    spendingMandate: tamperedMandate,
    policy: testPolicy
  });

  const res4 = await gateway4.processRequest({ paymentRequest: getSampleRequest('req_ks_04') });

  assertTest(
    '4. Tampering with signed mandate contents causes rejection',
    res4.decision.decision === 'BLOCK' &&
    res4.decision.reasonCodes.includes('MANDATE_INVALID') &&
    proc4.calls.length === 0,
    `Decision: ${res4.decision.decision}, Explanation: "${res4.decision.explanation}"`
  );

  // ----------------------------------------------------------------
  // TEST 5: Missing trusted admin public key fails closed
  // ----------------------------------------------------------------
  const proc5 = new MockProcessor();
  const gateway5 = new PayGuardGateway({
    processor: proc5,
    adminPublicKey: null, // Explicitly missing / unconfigured
    gatewayPrivateKey: gatewayKeys.privateKey,
    spendingMandate: validMandate,
    policy: testPolicy
  });

  const res5 = await gateway5.processRequest({ paymentRequest: getSampleRequest('req_ks_05') });

  const directVerifyCheck = verifyMandate(validMandate, { trustedAdminPublicKey: null });

  assertTest(
    '5. Missing trusted admin public key fails closed',
    res5.decision.decision === 'BLOCK' &&
    res5.decision.reasonCodes.includes('MANDATE_INVALID') &&
    directVerifyCheck.valid === false &&
    directVerifyCheck.reason.includes('TRUSTED_ADMIN_KEY_MISSING') &&
    proc5.calls.length === 0,
    `Decision: ${res5.decision.decision}, Direct Reason: "${directVerifyCheck.reason}", Processor Calls: ${proc5.calls.length}`
  );

  // ----------------------------------------------------------------
  // TEST 6: Receipt signing uses gateway key independently of admin key
  // ----------------------------------------------------------------
  const lastReceipt = gateway1.receiptLog.inMemoryLog[gateway1.receiptLog.inMemoryLog.length - 1];

  const { signature: receiptSig, publicKey: receiptPub, ...receiptPayload } = lastReceipt;
  const isSignedByGatewayKey = crypto.verify(
    null,
    Buffer.from(JSON.stringify(receiptPayload)),
    gatewayKeys.publicKey,
    Buffer.from(receiptSig, 'base64')
  );

  let signedByAdminKey = false;
  try {
    signedByAdminKey = crypto.verify(
      null,
      Buffer.from(JSON.stringify(receiptPayload)),
      adminKeys.publicKey,
      Buffer.from(receiptSig, 'base64')
    );
  } catch {
    signedByAdminKey = false;
  }

  assertTest(
    '6. Receipt signing uses gateway key independently of admin key',
    isSignedByGatewayKey === true &&
    signedByAdminKey === false &&
    gateway1.adminPublicKey !== gateway1.receiptLog.keyPair.publicKey,
    `Signed by Gateway Key: ${isSignedByGatewayKey}, Signed by Admin Key: ${signedByAdminKey}`
  );

  // ----------------------------------------------------------------
  // TEST 7: Offline signing CLI produces verifiable signature without leaking secrets
  // ----------------------------------------------------------------
  const tempDir = path.join(process.cwd(), 'artifacts');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const unsignedFile = path.join(tempDir, 'mandate_unsigned_cli_test.json');
  const signedFile = path.join(tempDir, 'test_signed_mandate_cli_out.json');

  fs.writeFileSync(unsignedFile, JSON.stringify({
    authorityName: 'Head of Infrastructure',
    expiresInDays: 45,
    policy: {
      policyId: 'policy_offline_cli_01',
      maxTransactionAmount: 150,
      dailyBudget: 800,
      allowedCategories: ['cloud_infrastructure'],
      newMerchantRequiresApproval: true
    }
  }), 'utf8');

  // Invoke CLI passing admin private key via environment variable ONLY (never CLI argument)
  let cliStdout = '';
  try {
    cliStdout = execFileSync(
      process.execPath,
      [path.join(process.cwd(), 'scripts', 'sign-mandate.js'), unsignedFile, signedFile],
      {
        env: {
          ...process.env,
          PAYGUARD_ADMIN_PRIVATE_KEY: adminKeys.privateKey
        },
        encoding: 'utf8'
      }
    );
  } finally {
    if (fs.existsSync(unsignedFile)) fs.unlinkSync(unsignedFile);
  }

  const cliSignedMandate = JSON.parse(fs.readFileSync(signedFile, 'utf8'));
  if (fs.existsSync(signedFile)) fs.unlinkSync(signedFile);

  const cliMandateVerification = verifyMandate(cliSignedMandate, { trustedAdminPublicKey: adminKeys.publicKey });
  const cliLeakedPrivateKey = cliStdout.includes('BEGIN PRIVATE KEY') || cliStdout.includes(adminKeys.privateKey.substring(30, 60));

  assertTest(
    '7. Offline signing CLI produces verifiable signature without exposing private key material',
    cliMandateVerification.valid === true &&
    cliLeakedPrivateKey === false &&
    cliSignedMandate.policy.policyId === 'policy_offline_cli_01',
    `CLI Verified: ${cliMandateVerification.valid}, Private Key Leaked in Output: ${cliLeakedPrivateKey}`
  );

  console.log('\n================================================================');
  console.log(`KEY SEPARATION SUMMARY: ${passedTests} / ${totalTests} TESTS PASSED`);
  console.log('================================================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runKeySeparationTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
