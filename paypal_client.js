import fs from 'fs';
import path from 'path';

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

let cachedToken = null;
let tokenExpiry = 0;

export async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry - 10000) {
    return cachedToken;
  }

  if (!clientId || !clientSecret) {
    throw new Error('Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET environment variables');
  }

  const authHeader = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Auth failed (${response.status}): ${data.error_description || data.error || 'Unknown error'}`);
  }

  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000);
  return cachedToken;
}

export async function paypalRequest(endpoint, options = {}) {
  const token = await getAccessToken();
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    ...(options.headers || {}),
  };

  const response = await fetch(`${baseUrl}${endpoint}`, {
    ...options,
    headers,
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  return {
    status: response.status,
    ok: response.ok,
    data,
  };
}

export async function createOrder({ amount = '20.00', currency = 'USD', intent = 'CAPTURE' }) {
  const payload = {
    intent: intent,
    purchase_units: [
      {
        amount: {
          currency_code: currency,
          value: String(amount),
        },
      },
    ],
  };

  return paypalRequest('/v2/checkout/orders', {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: {
      'Prefer': 'return=representation',
    },
  });
}

export async function captureOrder(orderId) {
  return paypalRequest(`/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
  });
}

export async function authorizeOrder(orderId) {
  return paypalRequest(`/v2/checkout/orders/${orderId}/authorize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
  });
}

export async function captureAuthorization(authorizationId, { amount = '20.00', currency = 'USD' } = {}) {
  const payload = {
    amount: {
      currency_code: currency,
      value: String(amount),
    },
    final_capture: true,
  };

  return paypalRequest(`/v2/authorizations/${authorizationId}/capture`, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: {
      'Prefer': 'return=representation',
    },
  });
}

export async function createPayout({
  senderBatchId,
  recipientEmail,
  amount = '1.00',
  currency = 'USD',
  note = 'PayGuard Payout Disbursement',
  senderItemId = `item_${Date.now()}`,
  paypalRequestId = null
}) {
  const payload = {
    sender_batch_header: {
      sender_batch_id: senderBatchId,
      email_subject: 'PayGuard Payment Disbursement',
      email_message: 'Payment disbursed via PayGuard Gateway.'
    },
    items: [
      {
        recipient_type: 'EMAIL',
        amount: {
          value: String(amount),
          currency
        },
        note,
        sender_item_id: senderItemId,
        receiver: recipientEmail
      }
    ]
  };

  const headers = {
    'Content-Type': 'application/json'
  };
  if (paypalRequestId) {
    headers['PayPal-Request-Id'] = paypalRequestId;
  }

  return paypalRequest('/v1/payments/payouts', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
}

export async function getPayoutBatch(payoutBatchId) {
  return paypalRequest(`/v1/payments/payouts/${payoutBatchId}`, {
    method: 'GET'
  });
}

