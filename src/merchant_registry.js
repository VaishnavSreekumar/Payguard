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
  constructor({ payoutRecipientEmail, vendorEmails = {} } = {}) {
    this.defaultPayoutRecipient = payoutRecipientEmail;
    this.vendorEmails = vendorEmails;
    this.registry = new Map();
    this.seedRegistry();
  }

  seedRegistry() {
    // Seed trusted default merchants with per-vendor payout emails
    this.registerMerchant({
      merchantId: 'aws',
      displayName: 'Amazon Web Services',
      aliases: ['aws', 'aws.com', 'aws.amazon.com', 'amazon web services'],
      category: 'cloud_infrastructure',
      trustLevel: 'TRUSTED',
      known: true,
      payoutEmail: this.vendorEmails.aws || process.env.PAYPAL_PAYOUT_EMAIL_AWS || this.defaultPayoutRecipient || process.env.PAYPAL_PAYOUT_RECIPIENT_EMAIL
    });

    this.registerMerchant({
      merchantId: 'github',
      displayName: 'GitHub',
      aliases: ['github', 'github.com', 'github inc', 'github.io'],
      category: 'developer_tools',
      trustLevel: 'TRUSTED',
      known: true,
      payoutEmail: this.vendorEmails.github || process.env.PAYPAL_PAYOUT_EMAIL_GITHUB || this.defaultPayoutRecipient || process.env.PAYPAL_PAYOUT_RECIPIENT_EMAIL
    });

    this.registerMerchant({
      merchantId: 'datadog',
      displayName: 'Datadog',
      aliases: ['datadog', 'datadoghq.com', 'datadog inc'],
      category: 'cloud_infrastructure',
      trustLevel: 'TRUSTED',
      known: true,
      payoutEmail: this.vendorEmails.datadog || process.env.PAYPAL_PAYOUT_EMAIL_DATADOG || this.defaultPayoutRecipient || process.env.PAYPAL_PAYOUT_RECIPIENT_EMAIL
    });

    this.registerMerchant({
      merchantId: 'giftcards-example',
      displayName: 'Example Gift Cards',
      aliases: ['giftcards-example', 'giftcards', 'giftcards.com', 'shady gift cards', 'example gift cards'],
      category: 'gift_cards',
      trustLevel: 'RESTRICTED',
      known: true,
      payoutEmail: null // Restricted vendor cannot receive payouts
    });
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
   * Fails closed if the merchant is untrusted or payout email is missing/blank.
   */
  getPayoutRecipient(merchantInput) {
    const resolved = this.resolveMerchant(merchantInput);
    if (!resolved.known) {
      throw new Error(`Untrusted merchant "${resolved.displayName}" cannot receive automated payouts.`);
    }

    const email = String(resolved.payoutEmail || this.defaultPayoutRecipient || process.env.PAYPAL_PAYOUT_RECIPIENT_EMAIL || '').trim();
    if (!email) {
      throw new Error(`Configuration error: No payout recipient configured for merchant "${resolved.displayName}". PAYPAL_PAYOUT_RECIPIENT_EMAIL is missing or blank.`);
    }

    return email;
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

    // 1. Direct lookup by ID
    if (inputId && this.registry.has(inputId)) {
      const rec = this.registry.get(inputId);
      const configuredEmail = (this.defaultPayoutRecipient !== undefined 
        ? this.defaultPayoutRecipient 
        : process.env.PAYPAL_PAYOUT_RECIPIENT_EMAIL || '').trim();
      return {
        ...rec,
        payoutEmail: rec.payoutEmail || configuredEmail || null
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
        const configuredEmail = (this.defaultPayoutRecipient !== undefined 
          ? this.defaultPayoutRecipient 
          : process.env.PAYPAL_PAYOUT_RECIPIENT_EMAIL || '').trim();
        return {
          ...record,
          payoutEmail: record.payoutEmail || configuredEmail || null
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

