import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createPaymentRequest, createHumanPolicy } from '../src/models.js';
import { PayGuardGateway } from '../src/gateway.js';
import { PaymentProcessor } from '../src/paypal_adapter.js';
import { createSpendingMandate, verifyMandate, generateKeyPair } from '../src/mandate.js';
import { ReceiptLog } from '../src/receipts.js';
import { PayGuardServer } from '../src/server.js';

class MockPayPalProcessor extends PaymentProcessor {
  constructor() {
    super();
    this.callCount = 0;
    this.lastRequest = null;
  }
  async createPayment(paymentRequest) {
    this.callCount++;
    this.lastRequest = paymentRequest;
    return {
      success: true,
      status: 201,
      orderId: `MOCK_PAYPAL_ORDER_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      orderStatus: 'CREATED',
      approvalUrl: `https://www.sandbox.paypal.com/checkoutnow?token=MOCK_TOKEN_${paymentRequest.requestId}`
    };
  }
}

async function runEvidenceTests() {
  console.log('================================================================');
  console.log('=== PAYGUARD EVIDENCE LAYER — 16 INTEGRATION TESTS ===');
  console.log('================================================================\n');

  let passedTests = 0;
  const totalTests = 16;
  const testLogPath = path.join(process.cwd(), 'test_evidence_receipts.jsonl');

  function cleanupTestLog() {
    if (fs.existsSync(testLogPath)) {
      try { fs.unlinkSync(testLogPath); } catch {}
    }
  }

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

  cleanupTestLog();

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

  // TEST 1: Valid mandate permits normal processing
  {
    cleanupTestLog();
    const processor = new MockPayPalProcessor();
    const gateway = new PayGuardGateway({ processor, policy: basePolicy });
    gateway.receiptLog.logFilePath = testLogPath;
    gateway.receiptLog.clearDisk();

    const req = createPaymentRequest({
      requestId: 'ev_t1',
      agentId: 'a1',
      merchant: { name: 'AWS', domain: 'aws.com', category: 'cloud_infrastructure' },
      amount: { value: 50 },
      purpose: 'S3 storage'
    });

    const res = await gateway.processRequest({ paymentRequest: req });
    assertTest(
      'TEST 1: Valid mandate permits normal processing',
      res.decision.decision === 'ALLOW' && processor.callCount === 1,
      `Decision: ${res.decision.decision}, PayPal Calls: ${processor.callCount}`
    );
  }

  // TEST 2: Modified mandate fails verification
  {
    const keyPair = generateKeyPair();
    const validMandate = createSpendingMandate({ policy: basePolicy, keyPair });

    // Tamper with maxTransactionAmount
    const tamperedMandate = {
      ...validMandate,
      policy: {
        ...validMandate.policy,
        maxTransactionAmount: 99999
      }
    };

    const verification = verifyMandate(tamperedMandate);
    assertTest(
      'TEST 2: Modified mandate fails verification',
      verification.valid === false && verification.reason.includes('SIGNATURE_INVALID'),
      `Verification valid: ${verification.valid}, Reason: ${verification.reason}`
    );
  }

  // TEST 3: Expired mandate blocks processing
  {
    cleanupTestLog();
    const processor = new MockPayPalProcessor();
    const gateway = new PayGuardGateway({ processor, policy: basePolicy });
    gateway.receiptLog.logFilePath = testLogPath;

    // Create an expired mandate manually
    const expiredMandate = createSpendingMandate({ policy: basePolicy, expiresInDays: -1 });
    gateway.spendingMandate = expiredMandate;

    const req = createPaymentRequest({
      requestId: 'ev_t3',
      agentId: 'a1',
      merchant: { name: 'AWS', domain: 'aws.com', category: 'cloud_infrastructure' },
      amount: { value: 50 },
      purpose: 'S3 storage'
    });

    const res = await gateway.processRequest({ paymentRequest: req });
    assertTest(
      'TEST 3: Expired mandate blocks processing',
      res.decision.decision === 'BLOCK' && res.decision.reasonCodes.includes('MANDATE_INVALID') && processor.callCount === 0,
      `Decision: ${res.decision.decision}, Reasons: ${res.decision.reasonCodes.join(', ')}, PayPal Calls: ${processor.callCount}`
    );
  }

  // TEST 4: ALLOW creates a signed receipt
  {
    cleanupTestLog();
    const processor = new MockPayPalProcessor();
    const gateway = new PayGuardGateway({ processor, policy: basePolicy });
    gateway.receiptLog.logFilePath = testLogPath;

    const req = createPaymentRequest({
      requestId: 'ev_t4',
      agentId: 'a1',
      merchant: { name: 'AWS', domain: 'aws.com', category: 'cloud_infrastructure' },
      amount: { value: 50 },
      purpose: 'S3'
    });

    await gateway.processRequest({ paymentRequest: req });
    const receipts = gateway.receiptLog.getReceiptsForRequest('ev_t4');

    assertTest(
      'TEST 4: ALLOW creates a signed receipt',
      receipts.length === 1 && receipts[0].decision === 'ALLOW' && receipts[0].paypalCalled === true && Boolean(receipts[0].signature),
      `Receipt Count: ${receipts.length}, Decision: ${receipts[0]?.decision}, PayPalCalled: ${receipts[0]?.paypalCalled}`
    );
  }

  // TEST 5: REQUIRE_APPROVAL creates a signed receipt
  {
    cleanupTestLog();
    const processor = new MockPayPalProcessor();
    const gateway = new PayGuardGateway({ processor, policy: basePolicy });
    gateway.receiptLog.logFilePath = testLogPath;

    const req = createPaymentRequest({
      requestId: 'ev_t5',
      agentId: 'a1',
      merchant: { name: 'AWS', domain: 'aws.com', category: 'cloud_infrastructure' },
      amount: { value: 500 }, // Exceeds single tx limit ($200) -> REQUIRE_APPROVAL
      purpose: 'Cluster upgrade requiring approval'
    });

    const res = await gateway.processRequest({ paymentRequest: req });
    const receipts = gateway.receiptLog.getReceiptsForRequest('ev_t5');

    assertTest(
      'TEST 5: REQUIRE_APPROVAL creates a signed receipt',
      receipts.length === 1 && receipts[0].decision === 'REQUIRE_APPROVAL' && receipts[0].paypalCalled === false,
      `Receipt Count: ${receipts.length}, Decision: ${receipts[0]?.decision}, PayPalCalled: ${receipts[0]?.paypalCalled}`
    );
  }

  // TEST 6: BLOCK creates a signed receipt
  {
    cleanupTestLog();
    const processor = new MockPayPalProcessor();
    const gateway = new PayGuardGateway({ processor, policy: basePolicy });
    gateway.receiptLog.logFilePath = testLogPath;

    const req = createPaymentRequest({
      requestId: 'ev_t6',
      agentId: 'a1',
      merchant: { name: 'Shady', domain: 'shady.com', category: 'gift_cards' },
      amount: { value: 50 },
      purpose: 'Gift card purchase'
    });

    await gateway.processRequest({ paymentRequest: req });
    const receipts = gateway.receiptLog.getReceiptsForRequest('ev_t6');

    assertTest(
      'TEST 6: BLOCK creates a signed receipt',
      receipts.length === 1 && receipts[0].decision === 'BLOCK' && receipts[0].paypalCalled === false,
      `Receipt Count: ${receipts.length}, Decision: ${receipts[0]?.decision}, PayPalCalled: ${receipts[0]?.paypalCalled}`
    );
  }

  // TEST 7: Receipt survives restart
  {
    cleanupTestLog();
    const keyPair = generateKeyPair();
    const log1 = new ReceiptLog({ logFilePath: testLogPath, keyPair });
    log1.append({
      mandateId: 'm1',
      requestId: 'req_restart',
      request: { agentId: 'a1', merchant: 'AWS', amount: 30, currency: 'USD', purpose: 'Disk persist test' },
      decision: 'ALLOW',
      reasonCodes: ['POLICY_ALLOWED'],
      paypalCalled: true,
      paypalRef: 'ORDER_123'
    });

    // Reload log from disk
    const log2 = new ReceiptLog({ logFilePath: testLogPath, keyPair });
    const verifyRes = log2.verifyChain();

    assertTest(
      'TEST 7: Receipt survives restart',
      log2.inMemoryLog.length === 1 && verifyRes.valid === true && log2.inMemoryLog[0].requestId === 'req_restart',
      `Loaded Count: ${log2.inMemoryLog.length}, Chain Valid: ${verifyRes.valid}`
    );
  }

  // TEST 8: Evidence endpoint returns correct request receipts
  {
    cleanupTestLog();
    const server = new PayGuardServer({ port: 3098 });
    await server.start();

    try {
      const requestId = `ev_api_req_${Date.now()}`;
      const payload = {
        requestId,
        agentId: 'agent-1',
        merchant: { name: 'AWS', domain: 'aws.com', category: 'cloud_infrastructure' },
        amount: { value: 40, currency: 'USD' },
        purpose: 'API evidence test'
      };

      await fetch('http://localhost:3098/api/payment-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const evRes = await fetch(`http://localhost:3098/api/evidence/${requestId}`);
      const evData = await evRes.json();

      assertTest(
        'TEST 8: Evidence endpoint returns correct request receipts',
        evData.requestId === requestId && Array.isArray(evData.receipts) && evData.receipts.length > 0 && evData.chain.valid === true,
        `ReqID Match: ${evData.requestId === requestId}, Receipts Count: ${evData.receipts?.length}, Chain Valid: ${evData.chain?.valid}`
      );
    } finally {
      await server.stop();
    }
  }

  // TEST 9: Tampering with amount is detected
  {
    cleanupTestLog();
    const keyPair = generateKeyPair();
    const log = new ReceiptLog({ logFilePath: testLogPath, keyPair });

    log.append({ mandateId: 'm1', requestId: 'r1', request: { agentId: 'a1', merchant: 'AWS', amount: 50 }, decision: 'ALLOW' });
    log.append({ mandateId: 'm1', requestId: 'r2', request: { agentId: 'a1', merchant: 'GitHub', amount: 80 }, decision: 'ALLOW' });

    // Tamper with receipt 0 amount in memory
    const tampered = [...log.inMemoryLog];
    tampered[0] = {
      ...tampered[0],
      request: { ...tampered[0].request, amount: 5000 }
    };

    const verifyRes = log.verifyChain(tampered);
    assertTest(
      'TEST 9: Tampering with amount is detected',
      verifyRes.valid === false && (verifyRes.reason.includes('SIGNATURE_INVALID') || verifyRes.reason.includes('CONTENT_TAMPERED')),
      `Chain Valid: ${verifyRes.valid}, Broken At: ${verifyRes.brokenAt}, Reason: ${verifyRes.reason}`
    );
  }

  // TEST 10: Changing BLOCK -> ALLOW is detected
  {
    cleanupTestLog();
    const keyPair = generateKeyPair();
    const log = new ReceiptLog({ logFilePath: testLogPath, keyPair });

    log.append({ mandateId: 'm1', requestId: 'r1', request: { agentId: 'a1', merchant: 'Shady', amount: 50 }, decision: 'BLOCK' });

    const tampered = [...log.inMemoryLog];
    tampered[0] = {
      ...tampered[0],
      decision: 'ALLOW'
    };

    const verifyRes = log.verifyChain(tampered);
    assertTest(
      'TEST 10: Changing BLOCK -> ALLOW is detected',
      verifyRes.valid === false && verifyRes.brokenAt === 0,
      `Chain Valid: ${verifyRes.valid}, Broken At: ${verifyRes.brokenAt}, Reason: ${verifyRes.reason}`
    );
  }

  // TEST 11: Deleting an entry is detected
  {
    cleanupTestLog();
    const keyPair = generateKeyPair();
    const log = new ReceiptLog({ logFilePath: testLogPath, keyPair });

    log.append({ mandateId: 'm1', requestId: 'r1', request: { agentId: 'a1', merchant: 'AWS', amount: 10 }, decision: 'ALLOW' });
    log.append({ mandateId: 'm1', requestId: 'r2', request: { agentId: 'a1', merchant: 'AWS', amount: 20 }, decision: 'ALLOW' });
    log.append({ mandateId: 'm1', requestId: 'r3', request: { agentId: 'a1', merchant: 'AWS', amount: 30 }, decision: 'ALLOW' });

    // Delete middle entry
    const tampered = [log.inMemoryLog[0], log.inMemoryLog[2]];

    const verifyRes = log.verifyChain(tampered);
    assertTest(
      'TEST 11: Deleting an entry is detected',
      verifyRes.valid === false && verifyRes.brokenAt === 1,
      `Chain Valid: ${verifyRes.valid}, Broken At: ${verifyRes.brokenAt}, Reason: ${verifyRes.reason}`
    );
  }

  // TEST 12: Reordering entries is detected
  {
    cleanupTestLog();
    const keyPair = generateKeyPair();
    const log = new ReceiptLog({ logFilePath: testLogPath, keyPair });

    log.append({ mandateId: 'm1', requestId: 'r1', request: { agentId: 'a1', merchant: 'AWS', amount: 10 }, decision: 'ALLOW' });
    log.append({ mandateId: 'm1', requestId: 'r2', request: { agentId: 'a1', merchant: 'AWS', amount: 20 }, decision: 'ALLOW' });

    // Swap order
    const tampered = [log.inMemoryLog[1], log.inMemoryLog[0]];

    const verifyRes = log.verifyChain(tampered);
    assertTest(
      'TEST 12: Reordering entries is detected',
      verifyRes.valid === false,
      `Chain Valid: ${verifyRes.valid}, Broken At: ${verifyRes.brokenAt}, Reason: ${verifyRes.reason}`
    );
  }

  // TEST 13: Replacing the signature is detected
  {
    cleanupTestLog();
    const keyPair1 = generateKeyPair();
    const keyPair2 = generateKeyPair();
    const log = new ReceiptLog({ logFilePath: testLogPath, keyPair: keyPair1 });

    log.append({ mandateId: 'm1', requestId: 'r1', request: { agentId: 'a1', merchant: 'AWS', amount: 10 }, decision: 'ALLOW' });

    // Create signature using keyPair2
    const current = log.inMemoryLog[0];
    const { signature, publicKey, ...payload } = current;
    const fakeSignature = crypto.sign(null, Buffer.from(JSON.stringify(payload)), keyPair2.privateKey).toString('base64');

    const fakeSigOnly = [{
      ...current,
      signature: fakeSignature // signed with wrong key
    }];
    const verifyRes = log.verifyChain(fakeSigOnly);

    assertTest(
      'TEST 13: Replacing the signature is detected',
      verifyRes.valid === false && verifyRes.reason.includes('SIGNATURE_INVALID'),
      `Chain Valid: ${verifyRes.valid}, Reason: ${verifyRes.reason}`
    );
  }

  // TEST 14: Invalid mandate prevents PayPal call
  {
    cleanupTestLog();
    const processor = new MockPayPalProcessor();
    const gateway = new PayGuardGateway({ processor, policy: basePolicy });
    gateway.receiptLog.logFilePath = testLogPath;

    // Invalidate mandate
    gateway.spendingMandate.signature = 'INVALID_SIGNATURE_STRING';

    const req = createPaymentRequest({
      requestId: 'ev_t14',
      agentId: 'a1',
      merchant: { name: 'AWS', domain: 'aws.com', category: 'cloud_infrastructure' },
      amount: { value: 10 },
      purpose: 'Attempting call with bad mandate'
    });

    const res = await gateway.processRequest({ paymentRequest: req });

    assertTest(
      'TEST 14: Invalid mandate prevents PayPal call',
      res.decision.decision === 'BLOCK' && processor.callCount === 0,
      `Decision: ${res.decision.decision}, PayPal Call Count: ${processor.callCount}`
    );
  }

  // TEST 15: BLOCK still results in zero PayPal calls
  {
    cleanupTestLog();
    const processor = new MockPayPalProcessor();
    const gateway = new PayGuardGateway({ processor, policy: basePolicy });
    gateway.receiptLog.logFilePath = testLogPath;

    const req = createPaymentRequest({
      requestId: 'ev_t15',
      agentId: 'a1',
      merchant: { name: 'AWS', domain: 'aws.com', category: 'cloud_infrastructure' },
      amount: { value: 5000 }, // Exceeds extreme threshold
      purpose: 'Excessive request'
    });

    const res = await gateway.processRequest({ paymentRequest: req });

    assertTest(
      'TEST 15: BLOCK still results in zero PayPal calls',
      res.decision.decision === 'BLOCK' && processor.callCount === 0,
      `Decision: ${res.decision.decision}, PayPal Calls: ${processor.callCount}`
    );
  }

  // TEST 16: REQUIRE_APPROVAL still results in zero PayPal calls before approval
  {
    cleanupTestLog();
    const processor = new MockPayPalProcessor();
    const gateway = new PayGuardGateway({ processor, policy: basePolicy });
    gateway.receiptLog.logFilePath = testLogPath;

    const req = createPaymentRequest({
      requestId: 'ev_t16',
      agentId: 'a1',
      merchant: { name: 'NewCorp', domain: 'newcorp.com', category: 'developer_tools' },
      amount: { value: 500 }, // Exceeds limit -> REQUIRE_APPROVAL
      purpose: 'Unrecognized merchant requiring approval'
    });

    const res = await gateway.processRequest({ paymentRequest: req });

    assertTest(
      'TEST 16: REQUIRE_APPROVAL results in zero PayPal calls before approval',
      res.decision.decision === 'REQUIRE_APPROVAL' && processor.callCount === 0,
      `Decision: ${res.decision.decision}, PayPal Calls before approval: ${processor.callCount}`
    );
  }

  cleanupTestLog();

  console.log('\n================================================================');
  console.log(`=== EVIDENCE SUITE SUMMARY: ${passedTests} / ${totalTests} TESTS PASSED ===`);
  console.log('================================================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runEvidenceTests().catch(err => {
  console.error('Evidence suite error:', err);
  process.exit(1);
});
