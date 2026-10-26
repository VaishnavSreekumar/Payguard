import { PayGuardGateway } from '../src/gateway.js';
import { PayGuardMerchantRegistry } from '../src/merchant_registry.js';
import { createPaymentRequest, createHumanPolicy } from '../src/models.js';
import { PaymentProcessor } from '../src/paypal_adapter.js';

async function runGatewayPayoutLifecycleTests() {
  console.log('================================================================');
  console.log('=== PAYGUARD GATEWAY PAYOUT LIFECYCLE & SPY SECURITY TESTS  ===');
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

  const testAwsEmail = 'aws-billing@amazon.example.com';
  const testGithubEmail = 'github-billing@github.example.com';
  const registry = new PayGuardMerchantRegistry({
    vendorEmails: {
      aws: testAwsEmail,
      github: testGithubEmail
    }
  });

  const testPolicy = createHumanPolicy({
    policyId: 'policy_test_01',
    maxTransactionAmount: 200,
    dailyBudget: 5000,
    allowedCategories: ['cloud_infrastructure', 'developer_tools'],
    newMerchantRequiresApproval: true
  });

  // Spy PaymentProcessor
  class SpyProcessor extends PaymentProcessor {
    constructor() {
      super();
      this.calls = [];
    }
    async createPayment(paymentRequest) {
      this.calls.push(paymentRequest);
      return {
        success: true,
        status: 201,
        batchId: 'BATCH_SPY_999',
        batchStatus: 'PENDING',
        raw: {
          items: [{ transaction_status: 'PENDING' }]
        }
      };
    }
  }

  // ----------------------------------------------------------------
  // TEST 1: Poisoned payee email -> BLOCK with PAYEE_OVERRIDE_ATTEMPT & processor NEVER called
  // ----------------------------------------------------------------
  const spy1 = new SpyProcessor();
  const gateway1 = new PayGuardGateway({
    processor: spy1,
    merchantRegistry: registry,
    policy: testPolicy
  });

  const poisonedReq = createPaymentRequest({
    requestId: 'req_spy_poison_01',
    agentId: 'agent_payout_01',
    merchant: {
      name: 'AWS',
      domain: 'aws.amazon.com',
      category: 'cloud_infrastructure',
      payoutEmail: 'attacker-wallet@evil.com' // Poisoned injection
    },
    amount: { value: 50, currency: 'USD' },
    purpose: 'Legit cloud invoice with injected attacker payee'
  });

  const resultPoisoned = await gateway1.processRequest({ paymentRequest: poisonedReq });

  assertTest(
    '1. Poisoned payee produces BLOCK with PAYEE_OVERRIDE_ATTEMPT and processor is NEVER called',
    resultPoisoned.decision.decision === 'BLOCK' &&
    resultPoisoned.decision.reasonCodes.includes('PAYEE_OVERRIDE_ATTEMPT') &&
    spy1.calls.length === 0,
    `Decision: ${resultPoisoned.decision.decision}, Reasons: [${resultPoisoned.decision.reasonCodes.join(', ')}], Processor Calls: ${spy1.calls.length}`
  );

  // ----------------------------------------------------------------
  // TEST 2: Legit request -> ALLOW and processor called with authoritative registry email only
  // ----------------------------------------------------------------
  const spy2 = new SpyProcessor();
  const gateway2 = new PayGuardGateway({
    processor: spy2,
    merchantRegistry: registry,
    policy: testPolicy
  });

  const legitReq = createPaymentRequest({
    requestId: 'req_spy_legit_02',
    agentId: 'agent_payout_01',
    merchant: { name: 'AWS', domain: 'aws.amazon.com', category: 'cloud_infrastructure' },
    amount: { value: 75, currency: 'USD' },
    purpose: 'Standard monthly S3 infrastructure'
  });

  const resultLegit = await gateway2.processRequest({ paymentRequest: legitReq });

  assertTest(
    '2. Legit request is ALLOWED and processor is invoked with authoritative payee only',
    resultLegit.decision.decision === 'ALLOW' &&
    spy2.calls.length === 1 &&
    resultLegit.merchantTrust.payoutRecipient === testAwsEmail,
    `Decision: ${resultLegit.decision.decision}, Processor Calls: ${spy2.calls.length}, Recipient: "${resultLegit.merchantTrust.payoutRecipient}"`
  );

  // ----------------------------------------------------------------
  // TEST 3: Registered vendor with inflated amount is blocked by cap (processor not called directly)
  // ----------------------------------------------------------------
  const spy3 = new SpyProcessor();
  const gateway3 = new PayGuardGateway({
    processor: spy3,
    merchantRegistry: registry,
    policy: testPolicy
  });

  const inflatedReq = createPaymentRequest({
    requestId: 'req_spy_inflated_03',
    agentId: 'agent_payout_01',
    merchant: { name: 'AWS', domain: 'aws.amazon.com', category: 'cloud_infrastructure' },
    amount: { value: 1200, currency: 'USD' }, // Exceeds 200 cap (>5x cap triggers hard BLOCK by cap)
    purpose: 'Massive compute instance'
  });

  const resultInflated = await gateway3.processRequest({ paymentRequest: inflatedReq });

  assertTest(
    '3. Registered vendor with inflated amount is blocked by cap and processor is not called',
    resultInflated.decision.decision === 'BLOCK' &&
    resultInflated.decision.reasonCodes.includes('AMOUNT_LIMIT_EXCEEDED') &&
    spy3.calls.length === 0,
    `Decision: ${resultInflated.decision.decision}, Reasons: [${resultInflated.decision.reasonCodes.join(', ')}], Processor Calls: ${spy3.calls.length}`
  );

  // ----------------------------------------------------------------
  // TEST 4: Receipt stores batchStatus, payoutItemStatus, and payoutBatchId
  // ----------------------------------------------------------------
  const lastReceipt = gateway2.receiptLog.inMemoryLog[gateway2.receiptLog.inMemoryLog.length - 1];

  assertTest(
    '4. Receipt stores batchStatus, payoutItemStatus, and payoutBatchId',
    lastReceipt.batchStatus === 'PENDING' &&
    lastReceipt.payoutItemStatus === 'PENDING' &&
    lastReceipt.payoutBatchId === 'BATCH_SPY_999',
    `Receipt Batch: ${lastReceipt.payoutBatchId}, Batch Status: ${lastReceipt.batchStatus}, Item Status: ${lastReceipt.payoutItemStatus}`
  );

  // ----------------------------------------------------------------
  // TEST 5: Daily spend is reserved when payout is PENDING or PROCESSING
  // ----------------------------------------------------------------
  const dailySpend = gateway2.ledger.getDailySpend('agent_payout_01');

  assertTest(
    '5. Daily spend is reserved when payout is PENDING or PROCESSING',
    dailySpend === 75,
    `Reserved Daily Spend: $${dailySpend}`
  );

  // ----------------------------------------------------------------
  // TEST 6: Uncertain processor outcome marks NEEDS_RECONCILIATION, keeps claim, never retries
  // ----------------------------------------------------------------
  class UncertainProcessor extends PaymentProcessor {
    async createPayment() {
      return {
        success: false,
        status: 409,
        uncertain: true,
        batchId: 'BATCH_UNCERTAIN_777',
        error: { message: 'Network timeout during confirmation' }
      };
    }
  }

  const gatewayUncertain = new PayGuardGateway({
    processor: new UncertainProcessor(),
    merchantRegistry: registry,
    policy: testPolicy
  });

  const uncertainReq = createPaymentRequest({
    requestId: 'req_uncertain_06',
    agentId: 'agent_payout_02',
    merchant: { name: 'GitHub', domain: 'github.com', category: 'developer_tools' },
    amount: { value: 40, currency: 'USD' },
    purpose: 'Copilot enterprise subscription'
  });

  const resultUncertain = await gatewayUncertain.processRequest({ paymentRequest: uncertainReq });

  // Verify claim remains locked in ledger
  const claimIsLocked = gatewayUncertain.ledger.hasSeen('req_uncertain_06');
  const reservedSpend = gatewayUncertain.ledger.getDailySpend('agent_payout_02');

  assertTest(
    '6. Uncertain outcome marks NEEDS_RECONCILIATION, reserves spend, keeps claim locked',
    resultUncertain.decision.status === 'NEEDS_RECONCILIATION' &&
    claimIsLocked === true &&
    reservedSpend === 40,
    `Decision Status: ${resultUncertain.decision.status}, Claim Locked: ${claimIsLocked}, Reserved Spend: $${reservedSpend}`
  );

  // ----------------------------------------------------------------
  // TEST 7: Gateway pollPayoutStatus returns live structured batch & item details
  // ----------------------------------------------------------------
  const mockPolledClient = {
    getPayoutBatch: async (batchId) => ({
      ok: true,
      status: 200,
      data: {
        batch_header: {
          payout_batch_id: batchId,
          batch_status: 'SUCCESS',
          amount: { value: '75.00', currency: 'USD' }
        },
        items: [
          {
            payout_item_id: 'ITEM_POLLED_01',
            transaction_id: 'TX_PAYPAL_VERIFIED_55',
            transaction_status: 'SUCCESS'
          }
        ]
      }
    })
  };

  const polledResult = await gateway2.pollPayoutStatus('BATCH_SPY_999', mockPolledClient);

  assertTest(
    '7. pollPayoutStatus retrieves verified batch_status, itemStatus, and transactionId',
    polledResult.success === true &&
    polledResult.batchStatus === 'SUCCESS' &&
    polledResult.itemStatus === 'SUCCESS' &&
    polledResult.transactionId === 'TX_PAYPAL_VERIFIED_55',
    `Batch: ${polledResult.batchStatus}, Item: ${polledResult.itemStatus}, TxID: ${polledResult.transactionId}`
  );

  console.log('\n================================================================');
  console.log(`LIFECYCLE & SPY SUMMARY: ${passedTests} / ${totalTests} TESTS PASSED`);
  console.log('================================================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runGatewayPayoutLifecycleTests();
