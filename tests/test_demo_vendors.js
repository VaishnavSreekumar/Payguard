import fs from 'fs';
import path from 'path';
import { PayGuardMerchantRegistry } from '../src/merchant_registry.js';
import { PayGuardGateway } from '../src/gateway.js';
import { createPaymentRequest, createHumanPolicy } from '../src/models.js';
import { PaymentProcessor } from '../src/paypal_adapter.js';

class SpyProcessor extends PaymentProcessor {
  constructor() {
    super();
    this.calls = [];
  }
  async createPayment(req) {
    this.calls.push(req);
    return { success: true, status: 201, batchId: 'BATCH_TEST_VENDOR', batchStatus: 'SUCCESS' };
  }
}

async function runDemoVendorTests() {
  console.log('================================================================');
  console.log('=== PAYGUARD ITEM B: DEMO VENDORS & SEED CONFIG TESTS        ===');
  console.log('================================================================\n');

  let passedTests = 0;
  const totalTests = 5;

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

  // Distinct test sandbox emails
  const primaryEmail = 'sb-primary@personal.example.internal';
  const awsDemoEmail = 'sb-aws-demo@personal.example.internal';
  const githubDemoEmail = 'sb-github-demo@personal.example.internal';

  const registry = new PayGuardMerchantRegistry({
    payoutRecipientEmail: primaryEmail,
    vendorEmails: {
      'aws-demo': awsDemoEmail,
      'github-demo': githubDemoEmail
    }
  });

  // ----------------------------------------------------------------
  // TEST 1: All three vendors have distinct registered payout recipients
  // ----------------------------------------------------------------
  const recipientPrimary = registry.getPayoutRecipient({ name: 'Amazon Web Services' });
  const recipientAwsDemo = registry.getPayoutRecipient({ name: 'AWS-demo' });
  const recipientGithubDemo = registry.getPayoutRecipient({ name: 'GitHub-demo' });

  const allDistinct = (
    recipientPrimary !== recipientAwsDemo &&
    recipientPrimary !== recipientGithubDemo &&
    recipientAwsDemo !== recipientGithubDemo
  );

  assertTest(
    '1. All three vendors have distinct registered payout recipients',
    allDistinct &&
    recipientPrimary === primaryEmail &&
    recipientAwsDemo === awsDemoEmail &&
    recipientGithubDemo === githubDemoEmail,
    `Primary: "${recipientPrimary}", AWS-demo: "${recipientAwsDemo}", GitHub-demo: "${recipientGithubDemo}"`
  );

  // ----------------------------------------------------------------
  // TEST 2: Unknown vendors are rejected
  // ----------------------------------------------------------------
  let unknownVendorBlocked = false;
  let unknownError = '';
  try {
    registry.getPayoutRecipient({ name: 'Random Unknown SaaS Vendor' });
  } catch (err) {
    unknownVendorBlocked = true;
    unknownError = err.message;
  }

  assertTest(
    '2. Unknown vendors are rejected from payout recipient resolution',
    unknownVendorBlocked === true && unknownError.includes('Untrusted merchant'),
    `Error caught: "${unknownError}"`
  );

  // ----------------------------------------------------------------
  // TEST 3: A request cannot redirect a registered vendor's payout to attacker-controlled email
  // ----------------------------------------------------------------
  const spy = new SpyProcessor();
  const gateway = new PayGuardGateway({
    processor: spy,
    merchantRegistry: registry,
    policy: createHumanPolicy({
      policyId: 'policy_test_vendor_redirect',
      maxTransactionAmount: 200,
      dailyBudget: 1000,
      allowedCategories: ['cloud_infrastructure', 'developer_tools'],
      newMerchantRequiresApproval: true
    })
  });

  const poisonedReq = createPaymentRequest({
    requestId: 'req_poison_vendor_01',
    agentId: 'agent_payout_sec',
    merchant: {
      name: 'AWS-demo',
      domain: 'aws-demo.example.internal',
      category: 'cloud_infrastructure',
      payoutEmail: 'attacker-redirect@evil-domain.com' // Attempted redirect
    },
    amount: { value: 70, currency: 'USD' },
    purpose: 'Standard monthly infrastructure charge with injected attacker email'
  });

  const redirectResult = await gateway.processRequest({ paymentRequest: poisonedReq });

  assertTest(
    '3. A request cannot redirect a registered vendor\'s payout to an attacker email',
    redirectResult.decision.decision === 'BLOCK' &&
    redirectResult.decision.reasonCodes.includes('PAYEE_OVERRIDE_ATTEMPT') &&
    spy.calls.length === 0,
    `Decision: ${redirectResult.decision.decision}, Reasons: [${redirectResult.decision.reasonCodes.join(', ')}], Calls: ${spy.calls.length}`
  );

  // ----------------------------------------------------------------
  // TEST 4: Missing recipient configuration fails closed
  // ----------------------------------------------------------------
  const unconfiguredRegistry = new PayGuardMerchantRegistry({
    payoutRecipientEmail: null,
    vendorEmails: {}
  });

  let awsDemoFailsClosed = false;
  let awsDemoErr = '';
  try {
    unconfiguredRegistry.getPayoutRecipient({ name: 'AWS-demo' });
  } catch (err) {
    awsDemoFailsClosed = true;
    awsDemoErr = err.message;
  }

  let githubDemoFailsClosed = false;
  let githubDemoErr = '';
  try {
    unconfiguredRegistry.getPayoutRecipient({ name: 'GitHub-demo' });
  } catch (err) {
    githubDemoFailsClosed = true;
    githubDemoErr = err.message;
  }

  assertTest(
    '4. Missing recipient configuration fails closed without falling back',
    awsDemoFailsClosed && githubDemoFailsClosed &&
    awsDemoErr.includes('No payout recipient configured') &&
    githubDemoErr.includes('No payout recipient configured'),
    `AWS-demo: "${awsDemoErr}", GitHub-demo: "${githubDemoErr}"`
  );

  // ----------------------------------------------------------------
  // TEST 5: No real account emails or secrets appear in the example seed file
  // ----------------------------------------------------------------
  const seedExamplePath = path.resolve(process.cwd(), 'seed.example');
  const seedExampleContent = fs.readFileSync(seedExamplePath, 'utf8');
  const parsedSeed = JSON.parse(seedExampleContent);

  const hasRealAwsEmail = !parsedSeed.vendors['aws-demo'].payoutEmail.includes('REPLACE_WITH');
  const hasRealGithubEmail = !parsedSeed.vendors['github-demo'].payoutEmail.includes('REPLACE_WITH');
  const containsSecrets = seedExampleContent.includes('secret') || seedExampleContent.includes('key');

  assertTest(
    '5. No real account emails or secrets appear in the example seed file',
    hasRealAwsEmail === false &&
    hasRealGithubEmail === false &&
    containsSecrets === false,
    `AWS placeholder: "${parsedSeed.vendors['aws-demo'].payoutEmail}", GitHub placeholder: "${parsedSeed.vendors['github-demo'].payoutEmail}"`
  );

  console.log('\n================================================================');
  console.log(`DEMO VENDOR SUMMARY: ${passedTests} / ${totalTests} TESTS PASSED`);
  console.log('================================================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runDemoVendorTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
