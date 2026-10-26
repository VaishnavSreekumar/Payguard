/**
 * Idempotency Ledger
 * Tracks executed requestIds to prevent duplicate replay attempts.
 */
export class IdempotencyLedger {
  constructor() {
    this.records = new Map();
    this.claimed = new Set(); // Synchronous atomic claim set for concurrency protection
    this.dailySpendMap = new Map(); // agentId:date -> number
  }

  /**
   * Atomically claims a requestId for execution.
   * Returns true if successfully claimed, false if already claimed or recorded.
   */
  claim(requestId) {
    if (!requestId) return false;
    const key = String(requestId);
    if (this.claimed.has(key) || this.records.has(key)) {
      return false;
    }
    this.claimed.add(key);
    return true;
  }

  /**
   * Checks if a requestId has already been processed or claimed
   */
  hasSeen(requestId) {
    if (!requestId) return false;
    const key = String(requestId);
    return this.claimed.has(key) || this.records.has(key);
  }

  /**
   * Records a processed request and its result
   */
  record(requestId, resultRecord) {
    if (!requestId) return;
    const key = String(requestId);
    this.claimed.add(key);
    this.records.set(key, {
      timestamp: new Date().toISOString(),
      ...resultRecord
    });
  }

  /**
   * Retrieves an existing recorded result
   */
  getRecord(requestId) {
    if (!requestId) return null;
    return this.records.get(String(requestId)) || null;
  }

  /**
   * Calculates total amount spent by an agent for today
   */
  getDailySpend(agentId, dateStr = new Date().toISOString().split('T')[0]) {
    const key = `${agentId}:${dateStr}`;
    return this.dailySpendMap.get(key) || 0;
  }

  /**
   * Records a successful spend towards daily budget
   */
  addDailySpend(agentId, amount, dateStr = new Date().toISOString().split('T')[0]) {
    const key = `${agentId}:${dateStr}`;
    const current = this.getDailySpend(agentId, dateStr);
    this.dailySpendMap.set(key, current + Number(amount));
  }

  /**
   * Clears the ledger (useful for testing)
   */
  clear() {
    this.records.clear();
    this.claimed.clear();
    this.dailySpendMap.clear();
  }
}
