import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { generateKeyPair } from './mandate.js';

export class ReceiptLog {
  constructor({ logFilePath = path.join(process.cwd(), 'payguard_receipts.jsonl'), keyPair } = {}) {
    this.logFilePath = logFilePath;
    this.keyPair = keyPair || generateKeyPair();
    this.inMemoryLog = [];
    this.loadFromDisk();
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
    const jsonStr = JSON.stringify(receiptData);
    return crypto.createHash('sha256').update(jsonStr).digest('hex');
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

    // Persist to disk
    fs.appendFileSync(this.logFilePath, JSON.stringify(fullReceipt) + '\n', 'utf8');

    return fullReceipt;
  }

  extractHashableData(receipt) {
    const { signature, ...hashable } = receipt;
    return hashable;
  }

  verifyChain(receiptsToVerify = null) {
    const list = receiptsToVerify || this.inMemoryLog;
    if (list.length === 0) {
      return { valid: true, count: 0, brokenAt: null, reason: 'OK: Empty log' };
    }

    for (let i = 0; i < list.length; i++) {
      const current = list[i];
      const { signature, publicKey, ...payload } = current;

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
      if (i === 0) {
        if (current.prevHash !== '0'.repeat(64)) {
          return {
            valid: false,
            count: list.length,
            brokenAt: 0,
            reason: 'HASH_CHAIN_INVALID: Genesis receipt prevHash is not 64 zeros.'
          };
        }
      } else {
        const expectedPrevHash = this.computeHash(this.extractHashableData(list[i - 1]));
        if (current.prevHash !== expectedPrevHash) {
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
