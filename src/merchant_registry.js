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

export class PayGuardMerchantRegistry {
  constructor({
    payoutRecipientEmail,
    vendorEmails = {},
    seedFilePath,
    isSandbox = null,
    paypalBaseUrl = null
  } = {}) {
    this.defaultPayoutRecipient = payoutRecipientEmail;
    this.vendorEmails = vendorEmails;
    this.seedFilePath = seedFilePath;
    this.paypalBaseUrl = paypalBaseUrl || process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com';
    this.isSandbox = this._determineSandbox(isSandbox, this.paypalBaseUrl);
    this.registry = new Map();
    this.seedRegistry();
  }

  _determineSandbox(isSandboxParam, paypalBaseUrlParam) {
    if (isSandboxParam !== null && isSandboxParam !== undefined) {
      return Boolean(isSandboxParam);
    }
    const env = (process.env.PAYPAL_ENVIRONMENT || process.env.PAYPAL_MODE || '').toLowerCase().trim();
    if (env === 'live' || env === 'production') {
      return false;
    }
    if (env === 'sandbox') {
      return true;
    }
    const url = String(paypalBaseUrlParam || process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com').toLowerCase();
    return url.includes('sandbox.paypal.com');
  }

  seedRegistry() {
    // 1. Primary demo vendor: AWS (resolves to primary sandbox account)
    this.registerMerchant({
      merchantId: 'aws',
      displayName: 'Amazon Web Services',
      aliases: ['aws', 'aws.com', 'aws.amazon.com', 'amazon web services'],
      category: 'cloud_infrastructure',
      trustLevel: 'TRUSTED',
      known: true,
      payoutEmail: this.vendorEmails.aws || process.env.PAYPAL_PAYOUT_EMAIL_AWS || this.defaultPayoutRecipient || process.env.PAYPAL_PAYOUT_RECIPIENT_EMAIL
    });

    // 2. Primary demo vendor: GitHub
    this.registerMerchant({
      merchantId: 'github',
      displayName: 'GitHub',
      aliases: ['github', 'github.com', 'github inc', 'github.io'],
      category: 'developer_tools',
      trustLevel: 'TRUSTED',
      known: true,
      payoutEmail: this.vendorEmails.github || process.env.PAYPAL_PAYOUT_EMAIL_GITHUB || this.defaultPayoutRecipient || process.env.PAYPAL_PAYOUT_RECIPIENT_EMAIL
    });

    // 3. Distinct demo vendor: AWS-demo (requires dedicated payout email)
    this.registerMerchant({
      merchantId: 'aws-demo',
      displayName: 'AWS Demo Vendor',
      aliases: ['aws-demo', 'aws-demo.example.internal'],
      category: 'cloud_infrastructure',
      trustLevel: 'TRUSTED',
      known: true,
      payoutEmail: this.vendorEmails['aws-demo'] || process.env.PAYPAL_PAYOUT_EMAIL_AWS_DEMO || null
    });

    // 4. Distinct demo vendor: GitHub-demo (requires dedicated payout email)
    this.registerMerchant({
      merchantId: 'github-demo',
      displayName: 'GitHub Demo Vendor',
      aliases: ['github-demo', 'github-demo.example.internal'],
      category: 'developer_tools',
      trustLevel: 'TRUSTED',
      known: true,
      payoutEmail: this.vendorEmails['github-demo'] || process.env.PAYPAL_PAYOUT_EMAIL_GITHUB_DEMO || null
    });

    // 5. Datadog monitoring
    this.registerMerchant({
      merchantId: 'datadog',
      displayName: 'Datadog',
      aliases: ['datadog', 'datadoghq.com', 'datadog inc'],
      category: 'cloud_infrastructure',
      trustLevel: 'TRUSTED',
      known: true,
      payoutEmail: this.vendorEmails.datadog || process.env.PAYPAL_PAYOUT_EMAIL_DATADOG || this.defaultPayoutRecipient || process.env.PAYPAL_PAYOUT_RECIPIENT_EMAIL
    });

    // 6. Restricted vendor test fixture
    this.registerMerchant({
      merchantId: 'giftcards-example',
      displayName: 'Example Gift Cards',
      aliases: ['giftcards-example', 'giftcards', 'giftcards.com', 'shady gift cards', 'example gift cards'],
      category: 'gift_cards',
      trustLevel: 'RESTRICTED',
      known: true,
      payoutEmail: null // Restricted vendor cannot receive payouts
    });

    // Load any local seed file (e.g. seed.json or custom path)
    this.loadSeedFile();
  }

  loadSeedFile() {
    const seedPath = this.seedFilePath || process.env.PAYGUARD_MERCHANT_SEED_FILE || path.resolve(process.cwd(), 'seed.json');
    if (fs.existsSync(seedPath)) {
      try {
        const raw = fs.readFileSync(seedPath, 'utf8');
        const parsed = JSON.parse(raw);
        const vendors = parsed.vendors || parsed.merchants || (Array.isArray(parsed) ? parsed : Object.values(parsed));

        if (Array.isArray(vendors)) {
          for (const v of vendors) {
            if (v && v.merchantId) this.registerMerchant(v);
          }
        } else if (typeof vendors === 'object') {
          for (const [key, v] of Object.entries(vendors)) {
            if (v) this.registerMerchant({ merchantId: key, ...v });
          }
        }
      } catch (err) {
        console.error(`[PayGuard Registry] Warning: Failed to parse seed file at ${seedPath}: ${err.message}`);
      }
    }
  }

  registerMerchant(record) {
    const id = record.merchantId.toLowerCase();
    this.registry.set(id, {
      merchantId: id,
      displayName: record.displayName || id,
      aliases: (record.aliases || [id]).map(a => a.toLowerCase()),
      category: record.category || 'general',
      trustLevel: record.trustLevel || 'UNKNOWN',
      known: Boolean(record.known),
      payoutEmail: record.payoutEmail ? String(record.payoutEmail).trim() : null
    });
  }

  /**
   * Authoritatively retrieves the configured payout recipient email for a vendor.
   * Fails closed if the merchant is untrusted or payout email is missing, blank, or invalid.
   */
  getPayoutRecipient(merchantInput) {
    const resolved = this.resolveMerchant(merchantInput);
    if (!resolved.known) {
      throw new Error(`Untrusted merchant "${resolved.displayName}" cannot receive automated payouts.`);
    }

    return this.validateRecipientEmail(resolved.payoutEmail, resolved.displayName, resolved.merchantId);
  }

  /**
   * Validates recipient email address based on active PayPal environment.
   * 
   * Strict Rules:
   * 1. Fails closed on missing, null, undefined, blank, or malformed email.
   * 2. Rejects placeholder strings (REPLACE_WITH, template brackets, placeholder prefixes).
   * 3. In PayPal Sandbox mode:
   *    - Accepts PayPal-generated simulated Sandbox addresses ending in @personal.example.com or @business.example.com.
   *    - Rejects generic plain example-domain placeholders (e.g. user@example.com).
   * 4. In Live / Production mode:
   *    - Strictly rejects any @personal.example.com, @business.example.com, or *.example.com addresses.
   *    - Strictly rejects any RFC 2606 example domains (example.com, example.net, example.org, .example).
   */
  validateRecipientEmail(email, merchantDisplayName = 'Merchant', merchantId = '') {
    const isDedicated = ['aws-demo', 'github-demo', 'giftcards-example'].includes(merchantId?.toLowerCase());
    const varName = merchantId === 'aws-demo'
      ? 'PAYPAL_PAYOUT_EMAIL_AWS_DEMO'
      : (merchantId === 'github-demo' ? 'PAYPAL_PAYOUT_EMAIL_GITHUB_DEMO' : 'PAYPAL_PAYOUT_RECIPIENT_EMAIL');

    if (!email || typeof email !== 'string') {
      throw new Error(`Configuration error: No payout recipient configured for merchant "${merchantDisplayName}". ${varName} is missing or blank.`);
    }

    const trimmed = email.trim();
    if (!trimmed) {
      throw new Error(`Configuration error: No payout recipient configured for merchant "${merchantDisplayName}". ${varName} is missing or blank.`);
    }

    // Basic email structure validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmed)) {
      throw new Error(`Configuration error: Invalid recipient email format for merchant "${merchantDisplayName}".`);
    }

    // Reject obvious placeholders
    if (trimmed.includes('REPLACE_WITH') || trimmed.includes('<') || trimmed.includes('>') || trimmed.startsWith('placeholder')) {
      throw new Error(`Configuration error: Placeholder recipient email rejected for merchant "${merchantDisplayName}".`);
    }

    const atIdx = trimmed.lastIndexOf('@');
    const domain = trimmed.slice(atIdx + 1).toLowerCase();

    // PayPal Sandbox simulated addresses (generated via PayPal Developer Dashboard)
    const isPayPalSandboxSimulatedAddress = domain === 'personal.example.com' || domain === 'business.example.com';

    // Generic RFC 2606 example domains
    const isGenericExampleDomain = domain === 'example.com' || domain === 'example.net' || domain === 'example.org' || domain.endsWith('.example');

    if (isPayPalSandboxSimulatedAddress) {
      if (!this.isSandbox) {
        throw new Error(`Configuration error: PayPal Sandbox recipient address ("@${domain}") is not permitted in live/production mode for merchant "${merchantDisplayName}".`);
      }
      return trimmed;
    }

    if (isGenericExampleDomain) {
      throw new Error(`Configuration error: Example domain recipient ("@${domain}") is not permitted for merchant "${merchantDisplayName}".`);
    }

    // In live mode, reject any other *.example.com subdomains
    if (!this.isSandbox && domain.endsWith('.example.com')) {
      throw new Error(`Configuration error: Example domain recipient ("@${domain}") is not permitted in live/production mode for merchant "${merchantDisplayName}".`);
    }

    return trimmed;
  }


  resolveMerchant(merchantInput) {
    if (!merchantInput) {
      return {
        merchantId: 'unknown',
        displayName: 'Unknown Merchant',
        category: 'general',
        trustLevel: 'UNKNOWN',
        known: false
      };
    }

    const inputId = String(merchantInput.merchantId || merchantInput.name || merchantInput.domain || '').toLowerCase().trim();
    const inputName = String(merchantInput.name || '').toLowerCase().trim();
    const inputDomain = String(merchantInput.domain || '').toLowerCase().trim();

    // Dedicated demo vendors must have explicit configuration and never silently fall back
    const isDedicatedDemo = (id) => ['aws-demo', 'github-demo', 'giftcards-example'].includes(id);

    // 1. Direct lookup by ID
    if (inputId && this.registry.has(inputId)) {
      const rec = this.registry.get(inputId);
      const configuredEmail = String(this.defaultPayoutRecipient !== undefined && this.defaultPayoutRecipient !== null 
        ? this.defaultPayoutRecipient 
        : process.env.PAYPAL_PAYOUT_RECIPIENT_EMAIL || '').trim();
      return {
        ...rec,
        payoutEmail: rec.payoutEmail || (isDedicatedDemo(rec.merchantId) ? null : configuredEmail) || null
      };
    }

    // 2. Lookup by alias / name / domain match
    for (const record of this.registry.values()) {
      const match = record.aliases.some(alias => 
        alias === inputId || 
        alias === inputName || 
        alias === inputDomain || 
        (inputDomain && inputDomain.includes(alias)) || 
        (inputName && inputName.includes(alias))
      );
      if (match) {
        const configuredEmail = String(this.defaultPayoutRecipient !== undefined && this.defaultPayoutRecipient !== null 
          ? this.defaultPayoutRecipient 
          : process.env.PAYPAL_PAYOUT_RECIPIENT_EMAIL || '').trim();
        return {
          ...record,
          payoutEmail: record.payoutEmail || (isDedicatedDemo(record.merchantId) ? null : configuredEmail) || null
        };
      }
    }

    // 3. Fallback for Unknown Merchants
    return {
      merchantId: inputId || 'unknown',
      displayName: merchantInput.name || 'Unknown Merchant',
      category: merchantInput.category || 'general',
      trustLevel: 'UNKNOWN',
      known: false,
      payoutEmail: null
    };
  }

  evaluateMerchantTrust(paymentRequest) {
    const agentClaimedCategory = String(paymentRequest.merchant?.category || 'general');
    const resolved = this.resolveMerchant(paymentRequest.merchant);

    const verifiedCategory = resolved.known ? resolved.category : agentClaimedCategory;
    const categoryMatch = resolved.known ? (agentClaimedCategory.toLowerCase() === resolved.category.toLowerCase()) : true;
    const categoryMismatchDetected = resolved.known && !categoryMatch;

    // Detect if agent/invoice proposal attempted to supply a recipient email
    const agentClaimedEmail = (
      paymentRequest.merchant?.payoutEmail ||
      paymentRequest.merchant?.recipientEmail ||
      paymentRequest.payoutEmail ||
      paymentRequest.recipientEmail ||
      paymentRequest.context?.payoutEmail ||
      null
    );

    let payoutRecipient = null;
    let recipientConfigError = null;
    let recipientOverrideAttempt = false;

    if (resolved.known) {
      try {
        payoutRecipient = this.getPayoutRecipient(paymentRequest.merchant);
      } catch (err) {
        recipientConfigError = err.message;
      }

      if (agentClaimedEmail && payoutRecipient) {
        if (agentClaimedEmail.toLowerCase().trim() !== payoutRecipient.toLowerCase().trim()) {
          recipientOverrideAttempt = true;
        }
      }
    }

    return {
      merchantId: resolved.merchantId,
      displayName: resolved.displayName,
      agentClaimedCategory,
      verifiedCategory,
      trustLevel: resolved.trustLevel,
      known: resolved.known,
      categoryMatch,
      categoryMismatchDetected,
      agentClaimedEmail,
      payoutRecipient,
      recipientConfigError,
      recipientOverrideAttempt,
      authority: 'PayGuard Trusted Merchant Registry'
    };
  }
}

