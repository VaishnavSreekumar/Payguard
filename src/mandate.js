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
 * Creates a signed spending mandate from a HumanPolicy object
 */
export function createSpendingMandate({
  policy,
  authorityName = 'Human Owner',
  expiresInDays = 30,
  keyPair
}) {
  if (!keyPair || !keyPair.privateKey) {
    keyPair = generateKeyPair();
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  const issuedAt = now.toISOString();

  const mandateId = `mandate_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  const mandatePayload = {
    mandateId,
    authorityName,
    policy: {
      policyId: policy.policyId || 'policy_devops_01',
      maxTransactionAmount: Number(policy.maxTransactionAmount),
      dailyBudget: Number(policy.dailyBudget),
      allowedCategories: policy.allowedCategories || [],
      newMerchantRequiresApproval: Boolean(policy.newMerchantRequiresApproval)
    },
    issuedAt,
    expiresAt,
  };

  const dataToSign = JSON.stringify(mandatePayload);
  const signature = crypto.sign(null, Buffer.from(dataToSign), keyPair.privateKey).toString('base64');

  return {
    ...mandatePayload,
    publicKey: keyPair.publicKey,
    signature,
  };
}

/**
 * Verifies a signed spending mandate
 */
export function verifyMandate(mandate) {
  if (!mandate || !mandate.signature || !mandate.publicKey) {
    return { valid: false, reason: 'INVALID_STRUCTURE: Missing signature or publicKey' };
  }

  const { signature, publicKey, ...payload } = mandate;
  const dataToSign = JSON.stringify(payload);

  try {
    const isSignatureValid = crypto.verify(
      null,
      Buffer.from(dataToSign),
      publicKey,
      Buffer.from(signature, 'base64')
    );

    if (!isSignatureValid) {
      return { valid: false, reason: 'SIGNATURE_INVALID: Mandate signature does not match' };
    }

    if (new Date() > new Date(mandate.expiresAt)) {
      return { valid: false, reason: 'EXPIRED: Mandate has passed expiration timestamp' };
    }

    return { valid: true, reason: 'OK' };
  } catch (err) {
    return { valid: false, reason: `VERIFICATION_ERROR: ${err.message}` };
  }
}
