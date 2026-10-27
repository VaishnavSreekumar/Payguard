import { StorageAdapter } from './interface.js';
import crypto from 'crypto';

export class MemoryStorageAdapter extends StorageAdapter {
  constructor() {
    super();
    this.ledger = new Map();     // requestId -> record
    this.claimed = new Set();    // Set of claimed requestIds
    this.approvals = new Map();  // approvalId -> approval
    this.receipts = [];          // list of receipts
  }

  async init() {
    return true;
  }

  async close() {
    return true;
  }

  async ping() {
    return true;
  }

  // -------------------------------------------------------------
  // Ledger & Idempotency
  // -------------------------------------------------------------

  async claimRequest({ requestId, agentId, amount, dateStr, maxDailyBudget = Infinity }) {
    if (!requestId) return { success: false, error: 'MISSING_REQUEST_ID' };
    const key = String(requestId);

    if (this.claimed.has(key) || this.ledger.has(key)) {
      return { success: false, isDuplicate: true };
    }

    const currentSpend = await this.getDailySpend(agentId, dateStr);
    const projectedSpend = currentSpend + Number(amount || 0);

    if (projectedSpend > maxDailyBudget) {
      return { success: false, budgetExceeded: true, currentSpend, projectedSpend };
    }

    this.claimed.add(key);
    this.ledger.set(key, {
      requestId: key,
      agentId,
      amount: Number(amount || 0),
      currency: 'USD',
      spendDate: dateStr,
      status: 'CLAIMED',
      decision: null,
      created_at: new Date().toISOString()
    });

    return { success: true, isDuplicate: false, reservedSpend: projectedSpend };
  }

  async releaseClaim(requestId) {
    if (!requestId) return;
    const key = String(requestId);
    this.claimed.delete(key);
    if (this.ledger.has(key)) {
      const rec = this.ledger.get(key);
      rec.status = 'RELEASED';
      rec.amount = 0; // Release spend
    }
  }

  async recordRequestResult(requestId, updateData) {
    if (!requestId) return;
    const key = String(requestId);
    this.claimed.add(key);

    const existing = this.ledger.get(key) || {
      requestId: key,
      created_at: new Date().toISOString()
    };

    this.ledger.set(key, {
      ...existing,
      ...updateData,
      updated_at: new Date().toISOString()
    });
  }

  async hasSeenRequest(requestId) {
    if (!requestId) return false;
    const key = String(requestId);
    return this.claimed.has(key) || this.ledger.has(key);
  }

  async getRequestRecord(requestId) {
    if (!requestId) return null;
    return this.ledger.get(String(requestId)) || null;
  }

  async getDailySpend(agentId, dateStr = new Date().toISOString().split('T')[0]) {
    let sum = 0;
    const activeStatuses = new Set(['CLAIMED', 'ALLOWED', 'PENDING', 'PROCESSING', 'SUCCESS', 'NEEDS_RECONCILIATION']);

    for (const rec of this.ledger.values()) {
      if (rec.agentId === agentId && rec.spendDate === dateStr && activeStatuses.has(rec.status)) {
        sum += Number(rec.amount || 0);
      }
    }
    return sum;
  }

  // -------------------------------------------------------------
  // Approvals
  // -------------------------------------------------------------

  async createApproval(approvalRecord) {
    const id = approvalRecord.approvalId || approvalRecord.approvalRequest?.approvalId;
    this.approvals.set(String(id), {
      ...approvalRecord,
      created_at: new Date().toISOString()
    });
    return approvalRecord;
  }

  async getApproval(approvalId) {
    if (!approvalId) return null;
    return this.approvals.get(String(approvalId)) || null;
  }

  async getAllApprovals() {
    return Array.from(this.approvals.values());
  }

  async resolveApproval(approvalId, { status, resolutionNote = '' }) {
    const key = String(approvalId);
    const existing = this.approvals.get(key);
    if (!existing) return null;

    // Check if currently PENDING
    const currentStatus = existing.status || existing.approvalRequest?.status;
    if (currentStatus !== 'PENDING') {
      return null; // Atomic protection: already resolved!
    }

    const updated = {
      ...existing,
      status,
      resolved_at: new Date().toISOString(),
      resolution_note: resolutionNote
    };

    if (updated.approvalRequest) {
      updated.approvalRequest.status = status;
    }

    this.approvals.set(key, updated);
    return updated;
  }

  // -------------------------------------------------------------
  // Cryptographic Receipts
  // -------------------------------------------------------------

  async appendReceipt(receiptRecord) {
    const seqIndex = this.receipts.length;
    const prevHash = seqIndex === 0
      ? '0'.repeat(64)
      : this.receipts[seqIndex - 1].hash;

    const receipt = {
      ...receiptRecord,
      seq_index: seqIndex,
      prev_hash: prevHash,
      created_at: new Date().toISOString()
    };

    this.receipts.push(receipt);
    return receipt;
  }

  async getReceipts({ requestId, limit = 50, offset = 0 } = {}) {
    let list = this.receipts;
    if (requestId) {
      list = list.filter(r => r.requestId === requestId || r.request_id === requestId);
    }
    return list.slice(offset, offset + limit);
  }

  async getLatestReceipt() {
    if (this.receipts.length === 0) return null;
    return this.receipts[this.receipts.length - 1];
  }

  async verifyReceiptChain() {
    if (this.receipts.length === 0) {
      return { valid: true, count: 0, reason: 'EMPTY_LOG' };
    }

    for (let i = 0; i < this.receipts.length; i++) {
      const current = this.receipts[i];
      const expectedPrevHash = i === 0 ? '0'.repeat(64) : this.receipts[i - 1].hash;

      if (current.prev_hash !== expectedPrevHash) {
        return { valid: false, count: this.receipts.length, brokenAt: i, reason: 'PREV_HASH_MISMATCH' };
      }
    }

    return { valid: true, count: this.receipts.length, reason: 'OK' };
  }
}
