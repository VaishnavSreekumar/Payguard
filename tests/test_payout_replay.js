import { PayPalPayoutsProcessor } from '../src/paypal_adapter.js';
import { PayGuardMerchantRegistry } from '../src/merchant_registry.js';
import { createPaymentRequest } from '../src/models.js';
import { IdempotencyLedger } from '../src/ledger.js';

/**
 * AUTOMATED REGRESSION SUITE: PAYGUARD PAYOUT REPLAY HANDLING
 * 
 * NOTE: These are local automated regression tests using MOCKED PayPal API responses.
 * They are clearly distinguished from the live PayPal Sandbox experiment executed in
 * scripts/payout-replay-spike.mjs, and require zero live credentials or network calls.
 */
async function runPayoutReplayRegressionTests() {
  console.log('================================================================');
  console.log('=== PAYGUARD MOCKED PAYOUT REPLAY REGRESSION TESTS ===');
  console.log('=== (Mocked API Responses — Zero External Network Calls)     ===');
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

  const testRecipient = 'sb-test-recipient@personal.example.com';
  const registry = new PayGuardMerchantRegistry({ payoutRecipientEmail: testRecipient });

  const req1 = createPaymentRequest({
    requestId: 'req_replay_test_001',
    agentId: 'agent_test_01',
    merchant: { name: 'AWS', domain: 'aws.amazon.com', category: 'cloud_infrastructure' },
    amount: { value: 15, currency: 'USD' },
    purpose: 'Initial cloud compute purchase'
  });

  // ----------------------------------------------------------------
  // TEST 1: Initial successful payout dispatch (Mock HTTP 201 Created)
  // ----------------------------------------------------------------
  const mockClientSuccess = {
    createPayout: async (params) => ({
      ok: true,
      status: 201,
      data: {
        batch_header: {
          payout_batch_id: 'BATCH_MOCK_101',
          batch_status: 'PENDING',
          sender_batch_header: { sender_batch_id: params.senderBatchId }
        }
      }
    }),
    getPayoutBatch: async (batchId) => ({
      ok: true,
      status: 200,
      data: {
        batch_header: { payout_batch_id: batchId, batch_status: 'SUCCESS' }
      }
    })
  };

  const processor1 = new PayPalPayoutsProcessor({
    merchantRegistry: registry,
    client: mockClientSuccess
  });

  const res1 = await processor1.createPayment(req1);

  assertTest(
    '1. Initial payout returns success (HTTP 201) with batch ID and real status',
    res1.success === true && res1.status === 201 && res1.batchId === 'BATCH_MOCK_101' && res1.isReplay === false,
    `Batch ID: ${res1.batchId}, Status: ${res1.status}, isReplay: ${res1.isReplay}`
  );

  // ----------------------------------------------------------------
  // TEST 2: Exact duplicate sender_batch_id rejection recovered safely
  // ----------------------------------------------------------------
  const mockClientReplayRejection = {
    createPayout: async () => ({
      ok: false,
      status: 400,
      data: {
        name: 'USER_BUSINESS_ERROR',
        message: 'User business error.',
        debug_id: 'mock_debug_replay_400',
        details: [
          {
            field: 'SENDER_BATCH_ID',
            issue: 'Batch with given sender_batch_id already exists',
            link: [
              {
                href: 'https://api.sandbox.paypal.com/v1/payments/payouts/BATCH_MOCK_101',
                rel: 'self',
                method: 'GET'
              }
            ]
          }
        ]
      }
    }),
    getPayoutBatch: async (batchId) => ({
      ok: true,
      status: 200,
      data: {
        batch_header: {
          payout_batch_id: batchId,
          batch_status: 'PROCESSING'
        }
      }
    })
  };

  const processorReplay = new PayPalPayoutsProcessor({
    merchantRegistry: registry,
    client: mockClientReplayRejection
  });

  const res2 = await processorReplay.createPayment(req1);

  assertTest(
    '2. Replayed request recovers existing batch representation and real status without double-paying',
    res2.success === true &&
    res2.status === 200 &&
    res2.batchId === 'BATCH_MOCK_101' &&
    res2.batchStatus === 'PROCESSING' &&
    res2.isReplay === true &&
    res2.recoveredFromExistingBatch === true,
    `Recovered Batch: ${res2.batchId}, Status: ${res2.status}, Real Batch Status: ${res2.batchStatus}`
  );

  // ----------------------------------------------------------------
  // TEST 3: Arbitrary HTTP 400 error is strictly NOT treated as a replay
  // ----------------------------------------------------------------
  const mockClientArbitrary400 = {
    createPayout: async () => ({
      ok: false,
      status: 400,
      data: {
        name: 'INVALID_REQUEST',
        message: 'Request is not well-formed.',
        details: [
          {
            field: '/items/0/amount/value',
            issue: 'INVALID_PARAMETER_VALUE'
          }
        ]
      }
    }),
    getPayoutBatch: async () => ({ ok: false, status: 404 })
  };

  const processorArbitrary400 = new PayPalPayoutsProcessor({
    merchantRegistry: registry,
    client: mockClientArbitrary400
  });

  const resArbitrary = await processorArbitrary400.createPayment(req1);

  assertTest(
    '3. Arbitrary HTTP 400 error is strictly NOT treated as replay recovery',
    resArbitrary.success === false &&
    resArbitrary.status === 400 &&
    resArbitrary.isReplay === undefined,
    `Status: ${resArbitrary.status}, Error name: ${resArbitrary.error?.name}`
  );

  // ----------------------------------------------------------------
  // TEST 4: If original batch lookup fails, return explicit uncertain error (never re-mint)
  // ----------------------------------------------------------------
  let createPayoutAttemptCount = 0;
  const mockClientLookupFails = {
    createPayout: async () => {
      createPayoutAttemptCount++;
      return {
        ok: false,
        status: 400,
        data: {
          name: 'USER_BUSINESS_ERROR',
          details: [
            {
              field: 'SENDER_BATCH_ID',
              issue: 'Batch with given sender_batch_id already exists',
              link: [{ href: 'https://api.sandbox.paypal.com/v1/payments/payouts/BATCH_ORPHAN_404' }]
            }
          ]
        }
      };
    },
    getPayoutBatch: async (id) => ({
      ok: false,
      status: 503,
      data: { name: 'SERVICE_UNAVAILABLE', message: 'Batch lookup failed' }
    })
  };

  const processorUncertain = new PayPalPayoutsProcessor({
    merchantRegistry: registry,
    client: mockClientLookupFails
  });

  const resUncertain = await processorUncertain.createPayment(req1);

  assertTest(
    '4. Failed batch retrieval returns explicit uncertain result without retrying',
    resUncertain.success === false &&
    resUncertain.uncertain === true &&
    resUncertain.status === 409 &&
    createPayoutAttemptCount === 1,
    `Uncertain: ${resUncertain.uncertain}, Status: ${resUncertain.status}, Re-mint attempts: 0 (Calls: ${createPayoutAttemptCount})`
  );

  // ----------------------------------------------------------------
  // TEST 5: Unhandled server failure reports failure cleanly without creating new batch
  // ----------------------------------------------------------------
  const mockClientError = {
    createPayout: async () => ({
      ok: false,
      status: 500,
      data: { name: 'INTERNAL_SERVER_ERROR', message: 'PayPal internal error' }
    }),
    getPayoutBatch: async () => ({ ok: false, status: 500 })
  };

  const processorError = new PayPalPayoutsProcessor({
    merchantRegistry: registry,
    client: mockClientError
  });

  const resError = await processorError.createPayment(req1);

  assertTest(
    '5. Unhandled server error reports failure cleanly without creating new batch',
    resError.success === false && resError.status === 500,
    `Status: ${resError.status}, Error: ${resError.error?.name}`
  );

  // ----------------------------------------------------------------
  // TEST 6: PayGuard IdempotencyLedger blocks replay before calling payment adapter
  // ----------------------------------------------------------------
  const ledger = new IdempotencyLedger();
  const firstClaim = ledger.claim('req_idempotency_check');
  const secondClaim = ledger.claim('req_idempotency_check');

  assertTest(
    '6. PayGuard in-memory claim ledger blocks local replay before network dispatch',
    firstClaim === true && secondClaim === false,
    `First Claim: ${firstClaim}, Second Claim: ${secondClaim} (Rejected by ledger)`
  );

  // ----------------------------------------------------------------
  // TEST 7: Distinct PayGuard request IDs derive distinct deterministic batch IDs
  // ----------------------------------------------------------------
  let capturedBatchIds = [];
  const mockCaptureClient = {
    createPayout: async (params) => {
      capturedBatchIds.push(params.senderBatchId);
      return {
        ok: true,
        status: 201,
        data: {
          batch_header: { payout_batch_id: `BATCH_${params.senderBatchId}`, batch_status: 'PENDING' }
        }
      };
    }
  };

  const processorDistinct = new PayPalPayoutsProcessor({
    merchantRegistry: registry,
    client: mockCaptureClient
  });

  const reqA = createPaymentRequest({
    requestId: 'req_distinct_A',
    agentId: 'agent_1',
    merchant: { name: 'AWS' },
    amount: { value: 10, currency: 'USD' },
    purpose: 'Task A'
  });

  const reqB = createPaymentRequest({
    requestId: 'req_distinct_B',
    agentId: 'agent_1',
    merchant: { name: 'AWS' },
    amount: { value: 10, currency: 'USD' },
    purpose: 'Task B'
  });

  await processorDistinct.createPayment(reqA);
  await processorDistinct.createPayment(reqB);

  assertTest(
    '7. Distinct PayGuard request IDs derive distinct deterministic batch IDs',
    capturedBatchIds.length === 2 && capturedBatchIds[0] !== capturedBatchIds[1],
    `Batch A: "${capturedBatchIds[0]}", Batch B: "${capturedBatchIds[1]}"`
  );

  console.log('\n================================================================');
  console.log(`REPLAY REGRESSION SUMMARY: ${passedTests} / ${totalTests} TESTS PASSED`);
  console.log('================================================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runPayoutReplayRegressionTests();
