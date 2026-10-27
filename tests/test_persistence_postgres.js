import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pg from 'pg';
import { PostgresStorageAdapter } from '../src/storage/postgres_adapter.js';
import { createStorageAdapter } from '../src/storage/factory.js';
import { PayGuardGateway } from '../src/gateway.js';
import { PaymentProcessor } from '../src/paypal_adapter.js';
import { createPaymentRequest, createHumanPolicy } from '../src/models.js';
import { APPROVAL_STATES } from '../src/approval_workflow.js';
import { ReceiptLog } from '../src/receipts.js';
import { runMigrations } from '../scripts/migrate.js';

const { Pool } = pg;

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) {
    let raw = process.env.DATABASE_URL.trim();
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      raw = raw.slice(1, -1).trim();
    }
    return raw;
  }

  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const dbLine = envContent.split(/\r?\n/).find(line => line.startsWith('DATABASE_URL='));
    if (dbLine) {
      let raw = dbLine.slice('DATABASE_URL='.length).trim();
      if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
        raw = raw.slice(1, -1).trim();
      }
      return raw;
    }
  }

  return null;
}

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
      batchId: `MOCK_BATCH_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      batchStatus: 'SUCCESS',
      raw: {
        items: [{ transaction_status: 'SUCCESS' }]
      }
    };
  }
}

async function runPersistenceIntegrationTests() {
  console.log('================================================================');
  console.log('=== PAYGUARD ITEM C: NEON POSTGRES PERSISTENCE TEST SUITE ===');
  console.log('================================================================\n');

  const dbUrl = resolveDatabaseUrl();
  if (!dbUrl) {
    console.error('CRITICAL: DATABASE_URL not available. Cannot run Postgres integration tests.');
    process.exit(1);
  }

  const TEST_SCHEMA = 'payguard_integration_test';
  let passedTests = 0;
  const totalTests = 6;

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

  // 0. Ensure schema exists and run migrations
  console.log(`Setting up isolated test schema "${TEST_SCHEMA}"...`);
  await runMigrations({ schema: TEST_SCHEMA, databaseUrl: dbUrl });

  // Clean test schema prior to running tests (strictly never touch public!)
  const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: true } });
  await pool.query(`SET search_path TO "${TEST_SCHEMA}"; TRUNCATE payguard_receipts, payguard_approvals, payguard_ledger, payguard_agent_daily_spend CASCADE;`);
  await pool.end();

  const testPolicy = createHumanPolicy({
    policyId: 'policy_persistence_test',
    name: 'Persistence Test Policy',
    maxTransactionAmount: 200,
    dailyBudget: 1000,
    allowedCategories: ['cloud_infrastructure', 'developer_tools'],
    newMerchantRequiresApproval: true
  });

  // -------------------------------------------------------------
  // TEST 1: Ledger, approvals, and receipts survive process restart
  // -------------------------------------------------------------
  {
    const storage1 = new PostgresStorageAdapter({ connectionString: dbUrl, schema: TEST_SCHEMA });
    await storage1.init({ verifyChainOnBoot: true });

    const gateway1 = new PayGuardGateway({
      processor: new MockPayPalProcessor(),
      policy: testPolicy,
      storage: storage1
    });
    await gateway1.receiptLog.init();

    const restartAgentId = `agent_restart_${Date.now()}`;
    const reqId1 = `req_restart_${Date.now()}`;
    const pReq1 = createPaymentRequest({
      requestId: reqId1,
      agentId: restartAgentId,
      merchant: { name: 'AWS', domain: 'aws.amazon.com', category: 'cloud_infrastructure' },
      amount: { value: 50 },
      purpose: 'Pre-restart payment'
    });

    const res1 = await gateway1.processRequest({ paymentRequest: pReq1 });

    // Create an approval request
    const reqId2 = `req_app_${Date.now()}`;
    const pReq2 = createPaymentRequest({
      requestId: reqId2,
      agentId: restartAgentId,
      merchant: { name: 'AWS', domain: 'aws.amazon.com', category: 'cloud_infrastructure' },
      amount: { value: 250 }, // Exceeds 200 limit -> approval required
      purpose: 'Escalated cluster upgrade'
    });

    const res2 = await gateway1.processRequest({ paymentRequest: pReq2 });
    const approvalId = res2.approvalRequest?.approvalId;

    // Ensure all pending storage writes flush cleanly
    await gateway1.receiptLog.flushStorage();

    // Shut down instance 1 (simulate process kill)
    await storage1.close();

    // Boot NEW instance 2 (simulate process boot)
    const storage2 = new PostgresStorageAdapter({ connectionString: dbUrl, schema: TEST_SCHEMA });
    await storage2.init({ verifyChainOnBoot: true });

    const gateway2 = new PayGuardGateway({
      processor: new MockPayPalProcessor(),
      policy: testPolicy,
      storage: storage2
    });
    await gateway2.receiptLog.init();

    // 1. Check ledger survived restart
    const ledgerRecord = await storage2.getRequestRecord(reqId1);
    const ledgerSurvives = ledgerRecord && ledgerRecord.request_id === reqId1 && ledgerRecord.decision === 'ALLOW';

    // 2. Check approval survived restart and can be retrieved
    const approvalRecord = await storage2.getApproval(approvalId);
    const approvalSurvives = approvalRecord && approvalRecord.approvalId === approvalId && approvalRecord.status === APPROVAL_STATES.PENDING;

    // 3. Check receipt chain verified on boot and contains receipts
    const receipts = await storage2.getReceipts({ limit: 10 });
    const chainCheck = await storage2.verifyReceiptChain();
    const receiptsSurvive = receipts.length >= 2 && chainCheck.valid === true;

    assertTest(
      'TEST 1: Ledger, approvals, and receipts surviving a process restart',
      ledgerSurvives && approvalSurvives && receiptsSurvive,
      `Ledger survived: ${ledgerSurvives}, Approval survived: ${approvalSurvives}, Receipts count: ${receipts.length}, Chain Valid: ${chainCheck.valid}`
    );

    await storage2.close();
  }

  // -------------------------------------------------------------
  // TEST 2: Concurrent spend-cap enforcement (Zero Overspend)
  // -------------------------------------------------------------
  {
    const storage = new PostgresStorageAdapter({ connectionString: dbUrl, schema: TEST_SCHEMA });
    await storage.init({ verifyChainOnBoot: true });

    const agentId = `agent_cap_${Date.now()}`;
    const dateStr = new Date().toISOString().split('T')[0];
    const maxBudget = 250;

    // Concurrently fire 10 claims of $50 each (Total attempted: $500; Budget: $250)
    // Exactly 5 claims should succeed ($250), and 5 must fail with budgetExceeded
    const concurrentClaims = Array.from({ length: 10 }, (_, i) => {
      const rId = `conc_spend_${Date.now()}_${i}`;
      return storage.claimRequest({
        requestId: rId,
        agentId,
        amount: 50,
        dateStr,
        maxDailyBudget: maxBudget
      });
    });

    const results = await Promise.all(concurrentClaims);
    const succeeded = results.filter(r => r.success === true);
    const budgetBlocked = results.filter(r => r.budgetExceeded === true);

    const finalSpend = await storage.getDailySpend(agentId, dateStr);

    assertTest(
      'TEST 2: Concurrent spend-cap enforcement with advisory locks',
      succeeded.length === 5 && budgetBlocked.length === 5 && finalSpend === 250,
      `Attempted: 10x$50, Succeeded: ${succeeded.length}, Budget-Blocked: ${budgetBlocked.length}, Final Cumulative Spend: $${finalSpend} (Budget: $${maxBudget})`
    );

    await storage.close();
  }

  // -------------------------------------------------------------
  // TEST 3: Concurrent duplicate request claims (Atomic Idempotency)
  // -------------------------------------------------------------
  {
    const storage = new PostgresStorageAdapter({ connectionString: dbUrl, schema: TEST_SCHEMA });
    await storage.init({ verifyChainOnBoot: true });

    const duplicateRequestId = `dup_claim_${Date.now()}`;
    const agentId = `agent_dup_${Date.now()}`;
    const dateStr = new Date().toISOString().split('T')[0];

    // Fire 10 concurrent claim requests for the exact same requestId
    const concurrentDupClaims = Array.from({ length: 10 }, () => {
      return storage.claimRequest({
        requestId: duplicateRequestId,
        agentId,
        amount: 25,
        dateStr,
        maxDailyBudget: 1000
      });
    });

    const results = await Promise.all(concurrentDupClaims);
    const firstClaim = results.filter(r => r.success === true && r.isDuplicate === false);
    const duplicateRejections = results.filter(r => r.success === false && r.isDuplicate === true);

    assertTest(
      'TEST 3: Concurrent duplicate request claims rejected by database uniqueness constraint',
      firstClaim.length === 1 && duplicateRejections.length === 9,
      `Concurrent Claims: 10, Exactly One Succeeded: ${firstClaim.length === 1}, Exactly 9 Rejected as Duplicates: ${duplicateRejections.length === 9}`
    );

    await storage.close();
  }

  // -------------------------------------------------------------
  // TEST 4: Receipt-chain continuity across restart
  // -------------------------------------------------------------
  {
    // Instance A logs 3 receipts
    const storageA = new PostgresStorageAdapter({ connectionString: dbUrl, schema: TEST_SCHEMA });
    await storageA.init({ verifyChainOnBoot: true });

    const keyPair = crypto.generateKeyPairSync('ed25519');
    const pubPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' });
    const privPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' });

    const logA = new ReceiptLog({ keyPair: { privateKey: privPem, publicKey: pubPem }, storage: storageA });
    await logA.init();

    for (let i = 0; i < 3; i++) {
      await logA.append({
        mandateId: 'mandate_continuity_test',
        requestId: `req_a_${i}`,
        request: { agentId: 'agent_4', merchant: 'AWS', amount: 20 },
        decision: 'ALLOW',
        reasonCodes: ['POLICY_ALLOWED']
      });
      await logA.flushStorage();
    }

    await storageA.close();

    // Instance B boots fresh, verifies continuity on boot, and appends 3 more receipts
    const storageB = new PostgresStorageAdapter({ connectionString: dbUrl, schema: TEST_SCHEMA });
    await storageB.init({ verifyChainOnBoot: true });

    const logB = new ReceiptLog({ keyPair: { privateKey: privPem, publicKey: pubPem }, storage: storageB });
    await logB.init();

    for (let j = 0; j < 3; j++) {
      await logB.append({
        mandateId: 'mandate_continuity_test',
        requestId: `req_b_${j}`,
        request: { agentId: 'agent_4', merchant: 'GitHub', amount: 30 },
        decision: 'ALLOW',
        reasonCodes: ['POLICY_ALLOWED']
      });
      await logB.flushStorage();
    }

    const receipts = await storageB.getReceipts({ limit: 50 });
    const chainVerification = await storageB.verifyReceiptChain();

    assertTest(
      'TEST 4: Receipt-chain continuity across process restart',
      chainVerification.valid === true && receipts.length >= 6,
      `Total Chain Length: ${receipts.length}, Chain Valid: ${chainVerification.valid}, Status: ${chainVerification.reason}`
    );

    await storageB.close();
  }

  // -------------------------------------------------------------
  // TEST 5: Corrupt stored state and unavailable database fail safely
  // -------------------------------------------------------------
  {
    // Part A: Tamper with a stored receipt in test schema to verify startup failure
    const rawPool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: true } });
    await rawPool.query(`
      UPDATE "${TEST_SCHEMA}".payguard_receipts
      SET payload = jsonb_set(payload::jsonb, '{decision}', '"COMPROMISED"')::text
      WHERE seq_index = 0;
    `);
    await rawPool.end();

    let startupCaught = false;
    let startupReason = '';
    const corruptStorage = new PostgresStorageAdapter({ connectionString: dbUrl, schema: TEST_SCHEMA });
    try {
      await corruptStorage.init({ verifyChainOnBoot: true });
    } catch (err) {
      startupCaught = true;
      startupReason = err.message;
    } finally {
      await corruptStorage.close();
    }

    // Part B: Verify unavailable database fails closed without silent fallback
    let unavailableCaught = false;
    let unavailableError = '';
    const unreachableStorage = new PostgresStorageAdapter({
      connectionString: 'postgresql://invalid_user:invalid_pass@127.0.0.1:54329/invalid_db?sslmode=disable'
    });
    try {
      await unreachableStorage.init({ verifyChainOnBoot: true });
    } catch (err) {
      unavailableCaught = true;
      unavailableError = err.message;
    } finally {
      await unreachableStorage.close();
    }

    assertTest(
      'TEST 5: Corrupt stored state and unavailable database fail safely and closed',
      startupCaught && startupReason.includes('RECEIPT_CHAIN_CORRUPT') && unavailableCaught,
      `Tamper Boot Refused: ${startupCaught} ("${startupReason.slice(0, 60)}..."), Unreachable DB Failed Closed: ${unavailableCaught}`
    );
  }

  // -------------------------------------------------------------
  // TEST 6: Production mode fails closed when DATABASE_URL is missing
  // -------------------------------------------------------------
  {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    let productionFailClosed = false;
    let productionErrorMessage = '';

    try {
      createStorageAdapter({ forceMemory: false, databaseUrl: '' });
    } catch (err) {
      productionFailClosed = true;
      productionErrorMessage = err.message;
    } finally {
      process.env.NODE_ENV = origEnv;
    }

    assertTest(
      'TEST 6: Production environment strictly fails closed when DATABASE_URL is missing',
      productionFailClosed === true && productionErrorMessage.includes('DATABASE_URL is missing in production environment'),
      `Fail-Closed Caught: ${productionFailClosed}, Error: "${productionErrorMessage}"`
    );
  }

  console.log('================================================================');
  console.log(`=== POSTGRES INTEGRATION SUITE: ${passedTests} / ${totalTests} TESTS PASSED ===`);
  console.log('================================================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runPersistenceIntegrationTests().catch(err => {
  console.error('Unhandled integration test suite error:', err);
  process.exit(1);
});
