import crypto from 'crypto';

/**
 * Generates an Ed25519 keypair for mandate signing/verification
 */
export function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

/**
 * Normalizes an unsigned mandate payload structure
 */
export function createSpendingMandatePayload({
  policy,
  authorityName = 'Human Owner',
  expiresInDays = 30,
  mandateId = null,
  issuedAt = null,
  expiresAt = null,
}) {
  const now = new Date();
  const actualIssuedAt = issuedAt || now.toISOString();
  const actualExpiresAt = expiresAt || new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  const actualMandateId = mandateId || `mandate_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  return {
    mandateId: actualMandateId,
    authorityName,
    policy: {
      policyId: policy.policyId || 'policy_devops_01',
      maxTransactionAmount: Number(policy.maxTransactionAmount),
      dailyBudget: Number(policy.dailyBudget),
      allowedCategories: policy.allowedCategories || [],
      newMerchantRequiresApproval: Boolean(policy.newMerchantRequiresApproval),
    },
    issuedAt: actualIssuedAt,
    expiresAt: actualExpiresAt,
  };
}

/**
 * Signs an unsigned mandate payload using an Ed25519 private key
 */
export function signMandatePayload(payload, privateKey) {
  let privPem = String(privateKey).trim();
  if (privPem.includes('\\n')) {
    privPem = privPem.replace(/\\n/g, '\n');
  }

  const privKeyObj = crypto.createPrivateKey(privPem);
  const dataToSign = JSON.stringify(payload);
  const signature = crypto.sign(null, Buffer.from(dataToSign), privKeyObj).toString('base64');

  // Derive public key for optional reference/metadata
  let publicKey = null;
  try {
    publicKey = crypto.createPublicKey(privKeyObj).export({ type: 'spki', format: 'pem' });
  } catch {
    // If public key derivation is unsupported for this key format
  }

  return {
    ...payload,
    ...(publicKey ? { publicKey } : {}),
    signature,
  };
}

/**
 * Creates a signed spending mandate from a policy object
 */
export function createSpendingMandate({
  policy,
  authorityName = 'Human Owner',
  expiresInDays = 30,
  keyPair,
  privateKey,
}) {
  const priv = privateKey || keyPair?.privateKey;
  if (!priv) {
    const generated = generateKeyPair();
    const payload = createSpendingMandatePayload({ policy, authorityName, expiresInDays });
    return signMandatePayload(payload, generated.privateKey);
  }

  const payload = createSpendingMandatePayload({ policy, authorityName, expiresInDays });
  return signMandatePayload(payload, priv);
}

/**
 * Verifies a signed spending mandate against the configured trusted admin public key.
 * 
 * Cryptographic trust boundary:
 * - Verification occurs EXCLUSIVELY against `trustedAdminPublicKey` or `PAYGUARD_ADMIN_PUBLIC_KEY`.
 * - Any embedded `publicKey` inside the mandate is treated as untrusted metadata and MUST NEVER establish trust.
 * - Fails closed if the trusted key is missing, malformed, or if signature verification fails.
 */
export function verifyMandate(mandate, { trustedAdminPublicKey } = {}) {
  if (!mandate || typeof mandate !== 'object' || !mandate.signature) {
    return { valid: false, reason: 'INVALID_STRUCTURE: Missing signature or mandate payload' };
  }

  // Resolve trusted admin public key
  let trustedKey = (trustedAdminPublicKey !== undefined
    ? trustedAdminPublicKey
    : (process.env.PAYGUARD_ADMIN_PUBLIC_KEY || '').trim() || null);

  if (typeof trustedKey === 'string') {
    trustedKey = trustedKey.trim();
    if (trustedKey.includes('\\n')) {
      trustedKey = trustedKey.replace(/\\n/g, '\n');
    }
  }

  if (!trustedKey) {
    return {
      valid: false,
      reason: 'TRUSTED_ADMIN_KEY_MISSING: No trusted admin public key configured in gateway',
    };
  }

  // Strip signature and embedded publicKey to reconstruct exact signed data
  const { signature, publicKey: _embeddedKey, ...payload } = mandate;
  const dataToSign = JSON.stringify(payload);

  try {
    const isSignatureValid = crypto.verify(
      null,
      Buffer.from(dataToSign),
      trustedKey, // Strict verification against trusted admin key ONLY
      Buffer.from(signature, 'base64')
    );

    if (!isSignatureValid) {
      return { valid: false, reason: 'SIGNATURE_INVALID: Mandate signature does not match trusted admin key' };
    }

    if (new Date() > new Date(mandate.expiresAt)) {
      return { valid: false, reason: 'EXPIRED: Mandate has passed expiration timestamp' };
    }

    return { valid: true, reason: 'OK' };
  } catch (err) {
    return { valid: false, reason: `VERIFICATION_ERROR: ${err.message}` };
  }
}
