import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Environment & Configuration Loader (Zero-dependency)
// ---------------------------------------------------------------------------
function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
}

loadEnv();

const clientId = process.env.PAYPAL_CLIENT_ID;
const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
const baseUrl = (process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com').replace(/\/$/, '');
const recipientEmail = (process.env.PAYPAL_PAYOUT_RECIPIENT_EMAIL || '').trim();

// ---------------------------------------------------------------------------
// Pre-flight Verification & Blocker Check
// ---------------------------------------------------------------------------
export function verifyPreflight() {
  const blockers = [];

  if (!clientId) {
    blockers.push('Missing PAYPAL_CLIENT_ID in environment or .env');
  }
  if (!clientSecret) {
    blockers.push('Missing PAYPAL_CLIENT_SECRET in environment or .env');
  }
  if (!baseUrl.includes('sandbox.paypal.com')) {
    blockers.push(`PAYPAL_BASE_URL must target sandbox ("${baseUrl}" is not a sandbox endpoint)`);
  }
  if (!recipientEmail) {
    blockers.push('Missing PAYPAL_PAYOUT_RECIPIENT_EMAIL in environment or .env. A real Sandbox personal account recipient must be configured.');
  }

  return {
    valid: blockers.length === 0,
    blockers,
    config: {
      baseUrl,
      nodeVersion: process.version,
      hasClientId: Boolean(clientId),
      hasClientSecret: Boolean(clientSecret),
      hasRecipientEmail: Boolean(recipientEmail)
    }
  };
}

// ---------------------------------------------------------------------------
// OAuth Helper (Tokens are never logged or stored in artifacts)
// ---------------------------------------------------------------------------
async function getAccessToken() {
  const authHeader = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`OAuth Authentication Failed (HTTP ${res.status}): ${errorText}`);
  }

  const data = await res.json();
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Filter Response Headers (Preserve debug IDs; never include auth)
// ---------------------------------------------------------------------------
function extractRelevantHeaders(headers) {
  const relevant = {};
  const allowedKeys = [
    'content-type',
    'date',
    'paypal-debug-id',
    'correlation-id',
    'paypal-request-id',
    'http_x_pp_az_locator'
  ];

  for (const [key, value] of headers.entries()) {
    if (allowedKeys.includes(key.toLowerCase()) || key.toLowerCase().startsWith('paypal-')) {
      relevant[key] = value;
    }
  }
  return relevant;
}

// ---------------------------------------------------------------------------
// Live Payout Replay Experiment Execution
// ---------------------------------------------------------------------------
export async function runPayoutReplaySpike() {
  console.log('================================================================');
  console.log('=== PAYGUARD P0: LIVE PAYPAL SANDBOX PAYOUT REPLAY SPIKE ===');
  console.log('================================================================\n');

  const preflight = verifyPreflight();
  if (!preflight.valid) {
    console.error('❌ PRE-FLIGHT CHECK FAILED WITH BLOCKERS:');
    preflight.blockers.forEach(b => console.error(`   - ${b}`));
    return {
      success: false,
      blocked: true,
      blockers: preflight.blockers
    };
  }

  console.log('✅ Pre-flight validation passed.');
  console.log(`   - Sandbox Base URL: ${baseUrl}`);
  console.log(`   - Node.js Version: ${process.version}`);
  console.log(`   - Recipient Email: (Configured via PAYPAL_PAYOUT_RECIPIENT_EMAIL)`);

  const experimentTimestamp = new Date().toISOString();
  const experimentId = `replay_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const senderBatchId = `batch_replay_${Date.now()}`;
  const paypalRequestId = `req_idempotent_${Date.now()}`;
  const senderItemId = `item_${Date.now()}`;

  const payoutPayload = {
    sender_batch_header: {
      sender_batch_id: senderBatchId,
      email_subject: 'PayGuard Idempotency & Replay Verification',
      email_message: 'Automated replay verification payout for PayGuard P0.'
    },
    items: [
      {
        recipient_type: 'EMAIL',
        amount: {
          value: '1.00',
          currency: 'USD'
        },
        note: 'PayGuard P0 Idempotency Verification Payout',
        sender_item_id: senderItemId,
        receiver: recipientEmail
      }
    ]
  };

  console.log('\n--- Identifiers for Sequential Replay ---');
  console.log(`   - sender_batch_id:   ${senderBatchId}`);
  console.log(`   - PayPal-Request-Id: ${paypalRequestId}`);
  console.log(`   - Amount:            $1.00 USD`);
  console.log(`   - Sender Item ID:    ${senderItemId}`);

  let token;
  try {
    token = await getAccessToken();
    console.log('\n✅ Sandbox OAuth Access Token obtained.');
  } catch (err) {
    console.error('❌ OAuth Token Acquisition Failed:', err.message);
    return { success: false, blocked: true, error: err.message };
  }

  // ATTEMPT 1
  console.log('\n>>> ATTEMPT 1: Initial POST /v1/payments/payouts <<<');
  const attempt1Timestamp = new Date().toISOString();
  let attempt1Res, attempt1Headers, attempt1Body;

  try {
    const res1 = await fetch(`${baseUrl}/v1/payments/payouts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': paypalRequestId
      },
      body: JSON.stringify(payoutPayload)
    });

    attempt1Res = { status: res1.status, ok: res1.ok };
    attempt1Headers = extractRelevantHeaders(res1.headers);
    const text1 = await res1.text();
    try {
      attempt1Body = JSON.parse(text1);
    } catch {
      attempt1Body = { raw: text1 };
    }

    console.log(`Attempt 1 HTTP Status: ${attempt1Res.status}`);
    console.log('Attempt 1 Headers:', JSON.stringify(attempt1Headers, null, 2));
    console.log('Attempt 1 Body:', JSON.stringify(attempt1Body, null, 2));
  } catch (err) {
    console.error('❌ Attempt 1 Network Exception:', err.message);
    return { success: false, error: err.message };
  }

  // ATTEMPT 2 (Sequential identical replay)
  console.log('\n>>> ATTEMPT 2: Sequential Identical POST /v1/payments/payouts <<<');
  const attempt2Timestamp = new Date().toISOString();
  let attempt2Res, attempt2Headers, attempt2Body;

  try {
    const res2 = await fetch(`${baseUrl}/v1/payments/payouts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': paypalRequestId
      },
      body: JSON.stringify(payoutPayload)
    });

    attempt2Res = { status: res2.status, ok: res2.ok };
    attempt2Headers = extractRelevantHeaders(res2.headers);
    const text2 = await res2.text();
    try {
      attempt2Body = JSON.parse(text2);
    } catch {
      attempt2Body = { raw: text2 };
    }

    console.log(`Attempt 2 HTTP Status: ${attempt2Res.status}`);
    console.log('Attempt 2 Headers:', JSON.stringify(attempt2Headers, null, 2));
    console.log('Attempt 2 Body:', JSON.stringify(attempt2Body, null, 2));
  } catch (err) {
    console.error('❌ Attempt 2 Network Exception:', err.message);
    return { success: false, error: err.message };
  }

  // STEP 6: Batch Details Lookup (if batch ID is present in either response)
  const batchId = attempt1Body?.batch_header?.payout_batch_id || attempt2Body?.batch_header?.payout_batch_id;
  let batchDetails = null;

  if (batchId) {
    console.log(`\n>>> STEP 6: Querying Payout Batch Details: GET /v1/payments/payouts/${batchId} <<<`);
    try {
      // Allow brief 2-second settle before lookup
      await new Promise(r => setTimeout(r, 2000));
      const batchRes = await fetch(`${baseUrl}/v1/payments/payouts/${batchId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      const batchText = await batchRes.text();
      try {
        batchDetails = {
          httpStatus: batchRes.status,
          headers: extractRelevantHeaders(batchRes.headers),
          body: JSON.parse(batchText)
        };
      } catch {
        batchDetails = {
          httpStatus: batchRes.status,
          headers: extractRelevantHeaders(batchRes.headers),
          body: { raw: batchText }
        };
      }
      console.log(`Batch Lookup HTTP Status: ${batchDetails.httpStatus}`);
      console.log('Batch Lookup Body:', JSON.stringify(batchDetails.body, null, 2));
    } catch (err) {
      console.error('Batch Lookup Exception:', err.message);
    }
  }

  // STEP 3: Write Evidence Artifact
  const artifactsDir = path.resolve(process.cwd(), 'artifacts');
  if (!fs.existsSync(artifactsDir)) {
    fs.mkdirSync(artifactsDir, { recursive: true });
  }

  const evidenceFilePath = path.join(artifactsDir, `paypal-replay-${experimentId}.json`);

  // Measured Conclusion
  let measuredConclusion = '';
  if (attempt1Res.status === 201 && attempt2Res.status === 201) {
    const b1 = attempt1Body?.batch_header?.payout_batch_id;
    const b2 = attempt2Body?.batch_header?.payout_batch_id;
    if (b1 === b2) {
      measuredConclusion = `PayPal Payouts returned HTTP 201 for both requests with the identical payout_batch_id ("${b1}"). Reusing sender_batch_id and PayPal-Request-Id returned the original batch representation.`;
    } else {
      measuredConclusion = `PayPal Payouts returned HTTP 201 for both requests but generated different batch IDs ("${b1}" vs "${b2}").`;
    }
  } else if (attempt2Res.status >= 400) {
    const errorName = attempt2Body?.name || attempt2Body?.message || 'Error';
    measuredConclusion = `Attempt 1 returned HTTP ${attempt1Res.status}. Sequential replay Attempt 2 was rejected by PayPal with HTTP ${attempt2Res.status} (${errorName}).`;
  } else {
    measuredConclusion = `Observed statuses: Attempt 1 = HTTP ${attempt1Res.status}, Attempt 2 = HTTP ${attempt2Res.status}.`;
  }

  const evidenceArtifact = {
    experimentMetadata: {
      experimentId,
      timestamp: experimentTimestamp,
      sandboxBaseUrl: baseUrl,
      nodeVersion: process.version
    },
    identifiers: {
      senderBatchId,
      paypalRequestId,
      senderItemId,
      recipientConfigured: Boolean(recipientEmail)
    },
    requestPayload: payoutPayload,
    attempt1: {
      timestamp: attempt1Timestamp,
      httpStatus: attempt1Res.status,
      headers: attempt1Headers,
      responseBody: attempt1Body
    },
    attempt2: {
      timestamp: attempt2Timestamp,
      httpStatus: attempt2Res.status,
      headers: attempt2Headers,
      responseBody: attempt2Body
    },
    batchDetailsLookup: batchDetails,
    measuredConclusion
  };

  fs.writeFileSync(evidenceFilePath, JSON.stringify(evidenceArtifact, null, 2), 'utf8');
  console.log(`\n✅ Evidence artifact written to: ${evidenceFilePath}`);

  return {
    success: true,
    evidenceFilePath,
    evidence: evidenceArtifact
  };
}

if (process.argv[1] && process.argv[1].endsWith('payout-replay-spike.mjs')) {
  runPayoutReplaySpike();
}
