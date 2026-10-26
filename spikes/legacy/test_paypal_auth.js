import fs from 'fs';
import path from 'path';

/**
 * Minimal environment variable loader to parse .env file
 * when not running with node --env-file.
 */
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
const baseUrl = process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com';

if (!clientId || !clientSecret) {
  console.error('PayPal authentication: FAILURE');
  console.error('Error: PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET environment variable is missing.');
  process.exit(1);
}

async function verifyPayPalAuth() {
  const authHeader = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const tokenUrl = `${baseUrl.replace(/\/$/, '')}/v1/oauth2/token`;

  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    const status = response.status;
    const data = await response.json().catch(() => ({}));

    if (response.ok) {
      console.log('PayPal authentication: SUCCESS');
      console.log(`HTTP Status: ${status}`);
      console.log(`Token received: ${Boolean(data && data.access_token)}`);
      if (data.app_id) {
        console.log(`App ID: ${data.app_id}`);
      }
      if (data.token_type) {
        console.log(`Token type: ${data.token_type}`);
      }
      if (data.expires_in) {
        console.log(`Expires in: ${data.expires_in} seconds`);
      }
    } else {
      console.log('PayPal authentication: FAILURE');
      console.log(`HTTP Status: ${status}`);
      console.log('Safe error response:', JSON.stringify({
        error: data.error || 'Authentication error',
        error_description: data.error_description || 'Authentication failed'
      }, null, 2));
    }
  } catch (err) {
    console.log('PayPal authentication: FAILURE');
    console.log('Network/System error:', err.message);
  }
}

verifyPayPalAuth();
