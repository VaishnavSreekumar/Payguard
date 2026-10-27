/**
 * StorageAdapter Interface
 * 
 * Abstract base class defining PayGuard's persistence contract across
 * both Neon PostgreSQL (durable production) and In-Memory (deterministic offline tests).
 */
export class StorageAdapter {
  async init() {
    throw new Error('StorageAdapter.init() must be implemented');
  }

  async close() {
    throw new Error('StorageAdapter.close() must be implemented');
  }

  // -------------------------------------------------------------
  // Idempotency & Spend Ledger Operations
  // -------------------------------------------------------------

  /**
   * Atomically claims a requestId and reserves daily spend if within policy budget.
   * 
   * Returns:
   *   { success: true, isDuplicate: false, reservedSpend: number }
   *   { success: false, isDuplicate: true }
   *   { success: false, budgetExceeded: true, currentSpend: number }
   */
  async claimRequest({ requestId, agentId, amount, dateStr, maxDailyBudget = Infinity }) {
    throw new Error('StorageAdapter.claimRequest() must be implemented');
  }

  /**
   * Releases an unexecuted spend reservation (e.g. when transaction is BLOCKED or REJECTED)
   */
  async releaseClaim(requestId) {
    throw new Error('StorageAdapter.releaseClaim() must be implemented');
  }

  /**
   * Finalizes the record of a completed or decided payment request
   */
  async recordRequestResult(requestId, {
    agentId,
    amount,
    currency,
    spendDate,
    status,
    decision,
    reasonCodes = [],
    paypalCalled = false,
    paypalRef = null,
    batchStatus = null,
    itemStatus = null,
    metadata = {}
  }) {
    throw new Error('StorageAdapter.recordRequestResult() must be implemented');
  }

  async hasSeenRequest(requestId) {
    throw new Error('StorageAdapter.hasSeenRequest() must be implemented');
  }

  async getRequestRecord(requestId) {
    throw new Error('StorageAdapter.getRequestRecord() must be implemented');
  }

  async getDailySpend(agentId, dateStr) {
    throw new Error('StorageAdapter.getDailySpend() must be implemented');
  }

  // -------------------------------------------------------------
  // Human Approvals Operations
  // -------------------------------------------------------------

  async createApproval(approvalRecord) {
    throw new Error('StorageAdapter.createApproval() must be implemented');
  }

  async getApproval(approvalId) {
    throw new Error('StorageAdapter.getApproval() must be implemented');
  }

  async getAllApprovals() {
    throw new Error('StorageAdapter.getAllApprovals() must be implemented');
  }

  /**
   * Atomically transitions an approval from PENDING -> APPROVED | REJECTED | EXPIRED
   * Returns the updated approval, or null if the approval was already resolved (race condition).
   */
  async resolveApproval(approvalId, { status, resolutionNote = '' }) {
    throw new Error('StorageAdapter.resolveApproval() must be implemented');
  }

  // -------------------------------------------------------------
  // Cryptographic Receipts & Hash Chain Operations
  // -------------------------------------------------------------

  async appendReceipt(receiptRecord) {
    throw new Error('StorageAdapter.appendReceipt() must be implemented');
  }

  async getReceipts({ requestId, limit = 50, offset = 0 } = {}) {
    throw new Error('StorageAdapter.getReceipts() must be implemented');
  }

  async getLatestReceipt() {
    throw new Error('StorageAdapter.getLatestReceipt() must be implemented');
  }

  async verifyReceiptChain() {
    throw new Error('StorageAdapter.verifyReceiptChain() must be implemented');
  }
}
