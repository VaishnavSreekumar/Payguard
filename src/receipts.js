import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { generateKeyPair } from './mandate.js';

export function computeReceiptHash(receiptData) {
  const jsonStr = JSON.stringify(receiptData);
  return crypto.createHash('sha256').update(jsonStr).digest('hex');
}

export function extractHashableData(receipt) {
  const { signature, hash, seq_index, prev_hash, ...hashable } = receipt;
  return hashable;
}

export class ReceiptLog {
  constructor({ logFilePath = path.join(process.cwd(), 'payguard_receipts.jsonl'), keyPair, gatewayPrivateKey, storage } = {}) {
    this.logFilePath = logFilePath;
    this.storage = storage;
    this.initGatewayKey({ keyPair, gatewayPrivateKey });
    this.inMemoryLog = [];
    if (!this.storage) {
      this.loadFromDisk();
    }
  }

  initGatewayKey({ keyPair, gatewayPrivateKey }) {
    if (keyPair && keyPair.privateKey) {
      let pub = keyPair.publicKey;
      if (!pub) {
        const privObj = crypto.createPrivateKey(keyPair.privateKey);
        pub = crypto.createPublicKey(privObj).export({ type: 'spki', format: 'pem' });
      }
      this.keyPair = { privateKey: keyPair.privateKey, publicKey: pub };
      return;
    }

    const rawKey = gatewayPrivateKey || process.env.PAYGUARD_GATEWAY_PRIVATE_KEY;
    if (rawKey) {
      let privPem = String(rawKey).trim();
      if (privPem.includes('\\n')) {
        privPem = privPem.replace(/\\n/g, '\n');
      }
      if (!privPem.includes('BEGIN') && fs.existsSync(privPem)) {
        privPem = fs.readFileSync(privPem, 'utf8').trim();
      }

      try {
        const privKeyObj = crypto.createPrivateKey(privPem);
        const pubKeyObj = crypto.createPublicKey(privKeyObj);
        this.keyPair = {
          privateKey: privPem,
          publicKey: pubKeyObj.export({ type: 'spki', format: 'pem' })
        };
        return;
      } catch (err) {
        throw new Error(`GATEWAY_RECEIPT_KEY_INVALID: Malformed or invalid gateway private key: ${err.message}`);
      }
    }

    // Dev/test fallback: ephemeral gateway keypair (separate from admin key)
    this.keyPair = generateKeyPair();
  }

  loadFromDisk() {
    this.inMemoryLog = [];
    if (fs.existsSync(this.logFilePath)) {
      const content = fs.readFileSync(this.logFilePath, 'utf8');
      const lines = content.split(/\r?\n/).filter(l => l.trim());
      for (const line of lines) {
        try {
          this.inMemoryLog.push(JSON.parse(line));
        } catch {
          // ignore corrupted lines
        }
      }
    }
  }

  computeHash(receiptData) {
    return computeReceiptHash(receiptData);
  }

  extractHashableData(receipt) {
    return extractHashableData(receipt);
  }

  async init() {
    if (this.storage) {
      try {
        const stored = await this.storage.getReceipts({ limit: 10000 });
        if (Array.isArray(stored) && stored.length > 0) {
          this.inMemoryLog = stored;
        }
      } catch (err) {
        console.error('[PayGuard Receipts] Warning: Could not initialize receipts from storage:', err.message);
      }
    }
    return this;
  }

  append({
    mandateId,
    requestId,
    request,
    decision,
    reasonCodes = [],
    paypalCalled = false,
    paypalRef = null,
    note = '',
    merchantTrust = null,
    batchStatus = null,
    payoutItemStatus = null,
    payoutBatchId = null,
    reconciliationNeeded = false
  }) {
    const index = this.inMemoryLog.length;
    const prevHash = index === 0
      ? '0'.repeat(64)
      : this.computeHash(this.extractHashableData(this.inMemoryLog[index - 1]));

    const receiptPayload = {
      receiptId: `rcpt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      index,
      timestamp: new Date().toISOString(),
      prevHash,
      mandateId: String(mandateId || 'mandate_default'),
      requestId: String(requestId),
      request: {
        agentId: request.agentId,
        merchant: request.merchant?.name || request.merchant,
        amount: request.amount?.value ?? request.amount,
        currency: request.amount?.currency || 'USD',
        purpose: request.purpose || '',
        merchantId: merchantTrust?.merchantId || request.merchant?.merchantId || 'unknown',
        agentClaimedCategory: merchantTrust?.agentClaimedCategory || request.merchant?.category || 'general',
        verifiedCategory: merchantTrust?.verifiedCategory || request.merchant?.category || 'general',
        merchantTrustLevel: merchantTrust?.trustLevel || 'UNKNOWN',
        categoryMatch: merchantTrust ? Boolean(merchantTrust.categoryMatch) : true
      },
      decision: String(decision),
      reasonCodes: Array.isArray(reasonCodes) ? reasonCodes : [],
      paypalCalled: Boolean(paypalCalled),
      paypalRef: paypalRef ? String(paypalRef) : null,
      batchStatus: batchStatus ? String(batchStatus) : null,
      payoutItemStatus: payoutItemStatus ? String(payoutItemStatus) : null,
      payoutBatchId: payoutBatchId ? String(payoutBatchId) : null,
      reconciliationNeeded: Boolean(reconciliationNeeded),
      note: String(note || '')
    };

    const dataToSign = JSON.stringify(receiptPayload);
    const signature = crypto.sign(null, Buffer.from(dataToSign), this.keyPair.privateKey).toString('base64');

    const fullReceipt = {
      ...receiptPayload,
      publicKey: this.keyPair.publicKey,
      signature
    };

    this.inMemoryLog.push(fullReceipt);

    // Persist to durable storage adapter if configured
    if (this.storage) {
      this.pendingStorageWrite = this.storage.appendReceipt(fullReceipt).then((saved) => {
        if (saved && saved.hash) {
          fullReceipt.hash = saved.hash;
          fullReceipt.seq_index = saved.seq_index;
          fullReceipt.prev_hash = saved.prev_hash;
        }
        return fullReceipt;
      }).catch(err => {
        console.error('[PayGuard Receipts] Warning: Failed to persist receipt to storage:', err.message);
      });
    }

    // Persist to local disk file if configured
    if (this.logFilePath) {
      try {
        fs.appendFileSync(this.logFilePath, JSON.stringify(fullReceipt) + '\n', 'utf8');
      } catch (err) {
        // Disk write fallback
      }
    }

    return fullReceipt;
  }

  async flushStorage() {
    if (this.pendingStorageWrite) {
      await this.pendingStorageWrite;
    }
  }


  verifyChain(receiptsToVerify = null) {
    const list = receiptsToVerify || this.inMemoryLog;
    if (list.length === 0) {
      return { valid: true, count: 0, brokenAt: null, reason: 'OK: Empty log' };
    }

    for (let i = 0; i < list.length; i++) {
      const current = list[i];
      const { signature, publicKey, hash, seq_index, prev_hash, ...payload } = current;

      // 1. Signature Verification
      try {
        const isSignatureValid = crypto.verify(
          null,
          Buffer.from(JSON.stringify(payload)),
          publicKey,
          Buffer.from(signature, 'base64')
        );
        if (!isSignatureValid) {
          return {
            valid: false,
            count: list.length,
            brokenAt: i,
            reason: `SIGNATURE_INVALID: Receipt at index ${i} signature check failed.`
          };
        }
      } catch (err) {
        return {
          valid: false,
          count: list.length,
          brokenAt: i,
          reason: `SIGNATURE_ERROR: Receipt at index ${i} verification threw error: ${err.message}`
        };
      }

      // 2. Hash Chain Verification
      const currentPrev = current.prevHash || current.prev_hash;
      if (i === 0) {
        if (currentPrev !== '0'.repeat(64)) {
          return {
            valid: false,
            count: list.length,
            brokenAt: 0,
            reason: 'HASH_CHAIN_INVALID: Genesis receipt prevHash is not 64 zeros.'
          };
        }
      } else {
        const expectedPrevHash = this.computeHash(this.extractHashableData(list[i - 1]));
        if (currentPrev !== expectedPrevHash) {
          return {
            valid: false,
            count: list.length,
            brokenAt: i,
            reason: `CONTENT_TAMPERED: Receipt at index ${i} prevHash mismatch with index ${i - 1}.`
          };
        }
      }
    }

    return {
      valid: true,
      count: list.length,
      brokenAt: null,
      reason: 'OK'
    };
  }

  getReceiptsForRequest(requestId) {
    return this.inMemoryLog.filter(r => r.requestId === String(requestId));
  }

  evidencePacket(requestId, mandate) {
    const requestReceipts = this.getReceiptsForRequest(requestId);
    const chainResult = this.verifyChain();

    return {
      requestId: String(requestId),
      mandate: mandate || null,
      receipts: requestReceipts,
      chain: {
        valid: chainResult.valid,
        count: chainResult.count,
        brokenAt: chainResult.brokenAt,
        reason: chainResult.reason
      }
    };
  }

  clearDisk() {
    this.inMemoryLog = [];
    if (fs.existsSync(this.logFilePath)) {
      fs.unlinkSync(this.logFilePath);
    }
  }
}
