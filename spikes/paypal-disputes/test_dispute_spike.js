import fs from 'fs';
import path from 'path';
import { getAccessToken, createOrder } from '../../paypal_client.js';

const baseUrl = (process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com').replace(/\/$/, '');

async function runDisputeSpike() {
  console.log('================================================================');
  console.log('=== PAYPAL DISPUTE SANDBOX — PERMISSION & END-TO-END SPIKE ===');
  console.log('================================================================\n');

  const results = {
    oauth: { attempted: false, status: null, ok: false, scope: null, error: null },
    createTransaction: { attempted: false, status: null, ok: false, orderId: null, error: null },
    listDisputes: { attempted: false, status: null, ok: false, count: 0, error: null },
    createDispute: { attempted: false, status: null, ok: false, disputeId: null, rawError: null, error: null },
    getDispute: { attempted: false, status: null, ok: false, state: null, error: null },
    requireEvidence: { attempted: false, status: null, ok: false, state: null, error: null },
    provideEvidence: { attempted: false, status: null, ok: false, state: null, error: null },
    getAfterEvidence: { attempted: false, status: null, ok: false, state: null, error: null },
    adjudicate: { attempted: false, status: null, ok: false, state: null, error: null },
    finalState: null
  };

  // STEP 1: OAuth Verification
  console.log('--- STEP 1: OAuth Verification ---');
  results.oauth.attempted = true;
  let token = null;
  try {
    const clientId = process.env.PAYPAL_CLIENT_ID;
    const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
    const authHeader = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    
    const tokenRes = await fetch(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    results.oauth.status = tokenRes.status;
    results.oauth.ok = tokenRes.ok;
    const tokenData = await tokenRes.json();

    if (tokenRes.ok) {
      token = tokenData.access_token;
      results.oauth.scope = tokenData.scope || 'N/A';
      console.log(`OAuth SUCCESS: HTTP ${tokenRes.status}`);
      console.log(`Token Scopes: ${results.oauth.scope}`);
    } else {
      results.oauth.error = tokenData.error_description || tokenData.error || 'OAuth Failed';
      console.log(`OAuth FAILED: HTTP ${tokenRes.status} - ${results.oauth.error}`);
    }
  } catch (err) {
    results.oauth.error = err.message;
    console.log(`OAuth EXCEPTION: ${err.message}`);
  }

  if (!token) return;

  // STEP 2: Create Sandbox Transaction
  console.log('\n--- STEP 2: Create Sandbox Transaction ---');
  results.createTransaction.attempted = true;
  try {
    const orderRes = await createOrder({ amount: '50.00', currency: 'USD', intent: 'CAPTURE' });
    results.createTransaction.status = orderRes.status;
    results.createTransaction.ok = orderRes.ok;
    if (orderRes.ok && orderRes.data && orderRes.data.id) {
      results.createTransaction.orderId = orderRes.data.id;
      console.log(`Order Creation SUCCESS: HTTP ${orderRes.status}`);
      console.log(`Order ID: ${orderRes.data.id} (Status: ${orderRes.data.status})`);
    } else {
      results.createTransaction.error = JSON.stringify(orderRes.data);
      console.log(`Order Creation FAILED: HTTP ${orderRes.status}`);
    }
  } catch (err) {
    results.createTransaction.error = err.message;
    console.log(`Order Creation EXCEPTION: ${err.message}`);
  }

  // STEP 3: List Disputes (Read Check)
  console.log('\n--- STEP 3: Read Disputes Permission Check (GET /v1/customer/disputes) ---');
  results.listDisputes.attempted = true;
  try {
    const listRes = await fetch(`${baseUrl}/v1/customer/disputes?page_size=5`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    results.listDisputes.status = listRes.status;
    results.listDisputes.ok = listRes.ok;
    const listData = await listRes.json();

    if (listRes.ok) {
      results.listDisputes.count = listData.items ? listData.items.length : 0;
      console.log(`List Disputes SUCCESS: HTTP ${listRes.status} (Count: ${results.listDisputes.count})`);
      if (listData.items && listData.items.length > 0) {
        console.log(`Existing Dispute Found: ${listData.items[0].dispute_id}`);
      }
    } else {
      results.listDisputes.error = JSON.stringify(listData);
      console.log(`List Disputes FAILED: HTTP ${listRes.status} - ${results.listDisputes.error}`);
    }
  } catch (err) {
    results.listDisputes.error = err.message;
    console.log(`List Disputes EXCEPTION: ${err.message}`);
  }

  // STEP 4: Test Dispute Creation
  console.log('\n--- STEP 4: Test Dispute Creation (POST /v1/customer/disputes) ---');
  results.createDispute.attempted = true;

  const testPayloads = [
    {
      name: 'Variant 1: buyer_transaction_id with MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      body: {
        disputed_transactions: [
          {
            buyer_transaction_id: results.createTransaction.orderId,
            create_time: new Date().toISOString()
          }
        ],
        reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
        dispute_flow: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
        dispute_amount: { currency_code: 'USD', value: '50.00' }
      }
    },
    {
      name: 'Variant 2: seller_transaction_id with MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      body: {
        disputed_transactions: [
          {
            seller_transaction_id: results.createTransaction.orderId,
            create_time: new Date().toISOString()
          }
        ],
        reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
        dispute_flow: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
        dispute_amount: { currency_code: 'USD', value: '50.00' }
      }
    },
    {
      name: 'Variant 3: UNAUTHORIZED_TRANSACTION reason & flow',
      body: {
        disputed_transactions: [
          {
            seller_transaction_id: results.createTransaction.orderId,
            create_time: new Date().toISOString()
          }
        ],
        reason: 'UNAUTHORIZED_TRANSACTION',
        dispute_flow: 'UNAUTHORIZED_TRANSACTION',
        dispute_amount: { currency_code: 'USD', value: '50.00' }
      }
    }
  ];

  for (const variant of testPayloads) {
    console.log(`\nTesting ${variant.name}...`);
    try {
      const disputeRes = await fetch(`${baseUrl}/v1/customer/disputes`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(variant.body)
      });

      results.createDispute.status = disputeRes.status;
      results.createDispute.ok = disputeRes.ok;
      const disputeData = await disputeRes.json();

      console.log(`HTTP Status: ${disputeRes.status}`);
      console.log(`Response JSON:`, JSON.stringify(disputeData, null, 2));

      if (disputeRes.ok && disputeData.dispute_id) {
        results.createDispute.disputeId = disputeData.dispute_id;
        console.log(`SUCCESS! Dispute Created ID: ${disputeData.dispute_id}`);
        break;
      } else {
        results.createDispute.rawError = disputeData;
        results.createDispute.error = `${disputeData.name || 'ERROR'}: ${disputeData.message || ''}`;
      }
    } catch (err) {
      console.log(`Exception: ${err.message}`);
    }
  }

  if (results.createDispute.ok && results.createDispute.disputeId) {
    const disputeId = results.createDispute.disputeId;

    // STEP 5: Retrieve Dispute
    console.log('\n--- STEP 5: Retrieve Dispute ---');
    results.getDispute.attempted = true;
    const getRes = await fetch(`${baseUrl}/v1/customer/disputes/${disputeId}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    results.getDispute.status = getRes.status;
    results.getDispute.ok = getRes.ok;
    const getData = await getRes.json();
    console.log(`Get Dispute HTTP ${getRes.status}:`, JSON.stringify(getData, null, 2));
    if (getRes.ok) results.getDispute.state = getData.status;

    // STEP 6: Require Evidence
    console.log('\n--- STEP 6: Require Evidence ---');
    results.requireEvidence.attempted = true;
    const reqEvRes = await fetch(`${baseUrl}/v1/customer/disputes/${disputeId}/require-evidence`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'BUYER_EVIDENCE' })
    });
    results.requireEvidence.status = reqEvRes.status;
    results.requireEvidence.ok = reqEvRes.ok;
    const reqEvData = await reqEvRes.json();
    console.log(`Require Evidence HTTP ${reqEvRes.status}:`, JSON.stringify(reqEvData, null, 2));
    if (reqEvRes.ok) results.requireEvidence.state = reqEvData.status;

    // STEP 7: Provide Evidence
    console.log('\n--- STEP 7: Provide Evidence ---');
    results.provideEvidence.attempted = true;
    const provRes = await fetch(`${baseUrl}/v1/customer/disputes/${disputeId}/provide-evidence`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        evidence_type: 'PROOF_OF_FULFILLMENT',
        notes: 'Proof of fulfillment provided.'
      })
    });
    results.provideEvidence.status = provRes.status;
    results.provideEvidence.ok = provRes.ok;
    const provData = await provRes.json();
    console.log(`Provide Evidence HTTP ${provRes.status}:`, JSON.stringify(provData, null, 2));
    if (provRes.ok) results.provideEvidence.state = provData.status;

    // STEP 8: Get After Evidence
    console.log('\n--- STEP 8: Get After Evidence ---');
    results.getAfterEvidence.attempted = true;
    const getAfterRes = await fetch(`${baseUrl}/v1/customer/disputes/${disputeId}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    results.getAfterEvidence.status = getAfterRes.status;
    results.getAfterEvidence.ok = getAfterRes.ok;
    const getAfterData = await getAfterRes.json();
    console.log(`Get After Evidence HTTP ${getAfterRes.status}:`, JSON.stringify(getAfterData, null, 2));
    if (getAfterRes.ok) results.getAfterEvidence.state = getAfterData.status;

    // STEP 9: Sandbox Adjudicate
    console.log('\n--- STEP 9: Sandbox Adjudicate ---');
    results.adjudicate.attempted = true;
    const adjRes = await fetch(`${baseUrl}/v1/customer/disputes/${disputeId}/adjudicate`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ adjudication_outcome: 'RESOLVED_BUYER_FAVOR' })
    });
    results.adjudicate.status = adjRes.status;
    results.adjudicate.ok = adjRes.ok;
    const adjData = await adjRes.json();
    console.log(`Adjudicate HTTP ${adjRes.status}:`, JSON.stringify(adjData, null, 2));
    if (adjRes.ok) {
      results.adjudicate.state = adjData.status;
      results.finalState = adjData.status;
    }
  }
}

runDisputeSpike().catch(err => {
  console.error('Spike error:', err.message);
});
