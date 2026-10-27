import pg from 'pg';
import crypto from 'crypto';
import { StorageAdapter } from './interface.js';
import { computeReceiptHash, extractHashableData } from '../receipts.js';

const { Pool } = pg;

function canonicalJson(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

export class PostgresStorageAdapter extends StorageAdapter {
  constructor({ connectionString, schema = 'public', poolConfig = {} } = {}) {
    super();
    if (!connectionString) {
      throw new Error('PostgresStorageAdapter requires a valid connectionString');
    }

    let rawUrl = String(connectionString).trim();
    if ((rawUrl.startsWith('"') && rawUrl.endsWith('"')) || (rawUrl.startsWith("'") && rawUrl.endsWith("'"))) {
      rawUrl = rawUrl.slice(1, -1).trim();
    }

    this.schema = schema || 'public';
    const isSslDisabled = rawUrl.includes('sslmode=disable');
    const defaultSsl = isSslDisabled ? false : { rejectUnauthorized: true };

    this.pool = new Pool({
      connectionString: rawUrl,
      connectionTimeoutMillis: 15000,
      ssl: poolConfig.ssl !== undefined ? poolConfig.ssl : defaultSsl,
      max: poolConfig.max || 25,
      idleTimeoutMillis: poolConfig.idleTimeoutMillis || 10000,
      ...poolConfig
    });
  }

  async init({ verifyChainOnBoot = true } = {}) {
    const client = await this.pool.connect();
    try {
      if (this.schema && this.schema !== 'public') {
        await client.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}";`);
        await client.query(`SET search_path TO "${this.schema}", public;`);
      }

      // Verify connection
      await client.query('SELECT 1;');

      if (verifyChainOnBoot) {
        const check = await this.verifyReceiptChain();
        if (!check.valid) {
          throw new Error(`RECEIPT_CHAIN_CORRUPT: Stored receipt audit chain failed integrity verification: ${check.reason} (broken at index ${check.brokenAt})`);
        }
      }

      return true;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end().catch(() => {});
  }

  async ping() {
    return this._withClient(async (client) => {
      const res = await client.query('SELECT 1 AS live;');
      return res.rows[0]?.live === 1;
    });
  }

  _t(name) {
    const s = this.schema || 'public';
    return `"${s}"."${name}"`;
  }

  async _withClient(callback) {
    const client = await this.pool.connect();
    try {
      if (this.schema) {
        await client.query(`SET search_path TO "${this.schema}", public;`);
      }
      return await callback(client);
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------
  // Idempotency & Spend Ledger Operations
  // -------------------------------------------------------------

  async claimRequest({ requestId, agentId, amount, dateStr, maxDailyBudget = Infinity }) {
    if (!requestId) return { success: false, error: 'MISSING_REQUEST_ID' };

    return await this._withClient(async (client) => {
      await client.query('BEGIN;');
      try {
        // 1. Ensure daily spend tracker exists
        await client.query(
          `INSERT INTO ${this._t('payguard_agent_daily_spend')} (agent_id, spend_date, total_spend)
           VALUES ($1, $2, 0)
           ON CONFLICT (agent_id, spend_date) DO NOTHING;`,
          [agentId, dateStr]
        );

        // 2. Lock the per-agent/date spend row with FOR UPDATE for strict serialization
        const spendRowRes = await client.query(
          `SELECT total_spend
           FROM ${this._t('payguard_agent_daily_spend')}
           WHERE agent_id = $1 AND spend_date = $2
           FOR UPDATE;`,
          [agentId, dateStr]
        );

        const currentSpend = parseFloat(spendRowRes.rows[0]?.total_spend || 0);
        const reqAmount = parseFloat(amount || 0);
        const projectedSpend = currentSpend + reqAmount;

        // 3. Check idempotency: Has this request already been claimed or recorded?
        const checkDup = await client.query(
          `SELECT request_id, status FROM ${this._t('payguard_ledger')} WHERE request_id = $1;`,
          [requestId]
        );

        if (checkDup.rows.length > 0) {
          await client.query('ROLLBACK;');
          return { success: false, isDuplicate: true };
        }

        // 4. Enforce daily spend limit
        if (projectedSpend > maxDailyBudget) {
          await client.query('ROLLBACK;');
          return {
            success: false,
            budgetExceeded: true,
            currentSpend,
            projectedSpend,
            maxDailyBudget
          };
        }

        // 5. Update daily spend reservation
        await client.query(
          `UPDATE ${this._t('payguard_agent_daily_spend')}
           SET total_spend = total_spend + $3
           WHERE agent_id = $1 AND spend_date = $2;`,
          [agentId, dateStr, reqAmount]
        );

        // 6. Atomically insert reservation claim in ledger
        await client.query(
          `INSERT INTO ${this._t('payguard_ledger')} 
           (request_id, agent_id, amount, currency, spend_date, status)
           VALUES ($1, $2, $3, 'USD', $4, 'CLAIMED');`,
          [requestId, agentId, reqAmount, dateStr]
        );

        await client.query('COMMIT;');
        return {
          success: true,
          isDuplicate: false,
          reservedSpend: projectedSpend
        };
      } catch (err) {
        await client.query('ROLLBACK;');
        // Database unique constraint violation (duplicate race)
        if (err.code === '23505') {
          return { success: false, isDuplicate: true };
        }
        throw err;
      }
    });
  }

  async releaseClaim(requestId) {
    if (!requestId) return;
    await this._withClient(async (client) => {
      await client.query('BEGIN;');
      try {
        const rowRes = await client.query(
          `SELECT agent_id, amount, spend_date, status
           FROM ${this._t('payguard_ledger')}
           WHERE request_id = $1
           FOR UPDATE;`,
          [requestId]
        );

        if (rowRes.rows.length > 0) {
          const { agent_id, amount, spend_date, status } = rowRes.rows[0];
          const releaseAmount = parseFloat(amount || 0);

          if (releaseAmount > 0 && status === 'CLAIMED') {
            await client.query(
              `UPDATE ${this._t('payguard_agent_daily_spend')}
               SET total_spend = GREATEST(0, total_spend - $3)
               WHERE agent_id = $1 AND spend_date = $2;`,
              [agent_id, spend_date, releaseAmount]
            );
          }

          await client.query(
            `UPDATE ${this._t('payguard_ledger')} 
             SET status = 'RELEASED', amount = 0, updated_at = NOW() 
             WHERE request_id = $1;`,
            [requestId]
          );
        }
        await client.query('COMMIT;');
      } catch (err) {
        await client.query('ROLLBACK;');
        throw err;
      }
    });
  }

  async recordRequestResult(requestId, {
    agentId,
    amount,
    currency = 'USD',
    spendDate = new Date().toISOString().split('T')[0],
    status,
    decision,
    reasonCodes = [],
    paypalCalled = false,
    paypalRef = null,
    batchStatus = null,
    itemStatus = null,
    metadata = {}
  }) {
    if (!requestId) return;

    await this._withClient(async (client) => {
      await client.query(
        `INSERT INTO ${this._t('payguard_ledger')} 
         (request_id, agent_id, amount, currency, spend_date, status, decision, reason_codes, paypal_called, paypal_ref, batch_status, item_status, metadata, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
         ON CONFLICT (request_id) DO UPDATE SET
           status = EXCLUDED.status,
           decision = EXCLUDED.decision,
           reason_codes = EXCLUDED.reason_codes,
           paypal_called = EXCLUDED.paypal_called,
           paypal_ref = EXCLUDED.paypal_ref,
           batch_status = EXCLUDED.batch_status,
           item_status = EXCLUDED.item_status,
           metadata = EXCLUDED.metadata,
           updated_at = NOW();`,
        [
          requestId,
          agentId || 'unknown',
          amount !== undefined ? amount : 0,
          currency,
          spendDate,
          status || 'UNKNOWN',
          decision || null,
          JSON.stringify(reasonCodes),
          Boolean(paypalCalled),
          paypalRef,
          batchStatus,
          itemStatus,
          JSON.stringify(metadata)
        ]
      );
    });
  }

  async hasSeenRequest(requestId) {
    if (!requestId) return false;
    return await this._withClient(async (client) => {
      const res = await client.query(
        `SELECT 1 FROM ${this._t('payguard_ledger')} WHERE request_id = $1 LIMIT 1;`,
        [requestId]
      );
      return res.rows.length > 0;
    });
  }

  async getRequestRecord(requestId) {
    if (!requestId) return null;
    return await this._withClient(async (client) => {
      const res = await client.query(
        `SELECT * FROM ${this._t('payguard_ledger')} WHERE request_id = $1 LIMIT 1;`,
        [requestId]
      );
      return res.rows[0] || null;
    });
  }

  async getDailySpend(agentId, dateStr = new Date().toISOString().split('T')[0]) {
    return await this._withClient(async (client) => {
      const activeStatuses = ['CLAIMED', 'ALLOWED', 'PENDING', 'PROCESSING', 'SUCCESS', 'NEEDS_RECONCILIATION'];
      const res = await client.query(
        `SELECT COALESCE(SUM(amount), 0) AS total_spend
         FROM ${this._t('payguard_ledger')}
         WHERE agent_id = $1 AND spend_date = $2 AND status = ANY($3::varchar[]);`,
        [agentId, dateStr, activeStatuses]
      );
      return parseFloat(res.rows[0].total_spend || 0);
    });
  }

  // -------------------------------------------------------------
  // Human Approvals Operations
  // -------------------------------------------------------------

  async createApproval(approvalRecord) {
    const req = approvalRecord.paymentRequest || {};
    const appObj = approvalRecord.approvalRequest || approvalRecord;

    await this._withClient(async (client) => {
      await client.query(
        `INSERT INTO ${this._t('payguard_approvals')}
         (approval_id, request_id, status, risk_level, amount, merchant_name, reason, policy_snapshot, payment_request, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (approval_id) DO NOTHING;`,
        [
          appObj.approvalId,
          req.requestId || appObj.requestId,
          appObj.status || 'PENDING',
          appObj.riskLevel || 'medium',
          appObj.amount || 0,
          appObj.merchant || req.merchant?.name || 'Unknown',
          appObj.reason || 'Approval required',
          JSON.stringify(approvalRecord.policySnapshot || {}),
          JSON.stringify(req),
          appObj.expiresAt || new Date(Date.now() + 3600000).toISOString()
        ]
      );
    });

    return approvalRecord;
  }

  async getApproval(approvalId) {
    if (!approvalId) return null;
    return await this._withClient(async (client) => {
      const res = await client.query(
        `SELECT * FROM ${this._t('payguard_approvals')} WHERE approval_id = $1 LIMIT 1;`,
        [approvalId]
      );
      if (res.rows.length === 0) return null;

      const r = res.rows[0];
      return {
        approvalId: r.approval_id,
        requestId: r.request_id,
        status: r.status,
        riskLevel: r.risk_level,
        amount: parseFloat(r.amount),
        merchant: r.merchant_name,
        reason: r.reason,
        policySnapshot: r.policy_snapshot,
        paymentRequest: r.payment_request,
        expiresAt: r.expires_at,
        resolvedAt: r.resolved_at,
        resolutionNote: r.resolution_note,
        createdAt: r.created_at
      };
    });
  }

  async getAllApprovals() {
    return await this._withClient(async (client) => {
      const res = await client.query(
        `SELECT * FROM ${this._t('payguard_approvals')} ORDER BY created_at DESC;`
      );
      return res.rows.map(r => ({
        approvalId: r.approval_id,
        requestId: r.request_id,
        status: r.status,
        riskLevel: r.risk_level,
        amount: parseFloat(r.amount),
        merchant: r.merchant_name,
        reason: r.reason,
        policySnapshot: r.policy_snapshot,
        paymentRequest: r.payment_request,
        expiresAt: r.expires_at,
        resolvedAt: r.resolved_at,
        resolutionNote: r.resolution_note,
        createdAt: r.created_at
      }));
    });
  }

  async resolveApproval(approvalId, { status, resolutionNote = '' }) {
    if (!approvalId) return null;
    return await this._withClient(async (client) => {
      // Atomic status transition from PENDING only
      const res = await client.query(
        `UPDATE ${this._t('payguard_approvals')}
         SET status = $1, resolved_at = NOW(), resolution_note = $2, updated_at = NOW()
         WHERE approval_id = $3 AND status = 'PENDING'
         RETURNING *;`,
        [status, resolutionNote, approvalId]
      );

      if (res.rows.length === 0) {
        return null; // Atomic protection: already resolved or does not exist
      }

      const r = res.rows[0];
      return {
        approvalId: r.approval_id,
        requestId: r.request_id,
        status: r.status,
        resolvedAt: r.resolved_at,
        resolutionNote: r.resolution_note
      };
    });
  }

  // -------------------------------------------------------------
  // Cryptographic Receipts & Hash Chain Operations
  // -------------------------------------------------------------

  async appendReceipt(receiptRecord) {
    return await this._withClient(async (client) => {
      await client.query('BEGIN;');
      try {
        // Lock receipts table for continuous sequence indexing
        const lastRowRes = await client.query(
          `SELECT seq_index, hash FROM ${this._t('payguard_receipts')} ORDER BY seq_index DESC LIMIT 1 FOR UPDATE;`
        );

        let seqIndex = 0n;
        let prevHash = '0'.repeat(64);

        if (lastRowRes.rows.length > 0) {
          seqIndex = BigInt(lastRowRes.rows[0].seq_index) + 1n;
          prevHash = lastRowRes.rows[0].hash;
        }

        const fullReceipt = {
          ...receiptRecord,
          mandateId: receiptRecord.mandateId || 'mandate_default',
          requestId: receiptRecord.requestId || 'req_unspecified',
          decision: receiptRecord.decision || 'UNKNOWN',
          publicKey: receiptRecord.publicKey || '',
          signature: receiptRecord.signature || '',
          index: receiptRecord.index !== undefined ? receiptRecord.index : Number(seqIndex),
          prevHash: receiptRecord.prevHash || prevHash,
          seq_index: seqIndex.toString(),
          prev_hash: receiptRecord.prev_hash || receiptRecord.prevHash || prevHash
        };

        // Compute SHA-256 hash using standard hashable data extraction
        const hash = computeReceiptHash(extractHashableData(fullReceipt));

        await client.query(
          `INSERT INTO ${this._t('payguard_receipts')}
           (receipt_id, seq_index, prev_hash, hash, mandate_id, request_id, decision, reason_codes, paypal_called, paypal_ref, batch_status, payout_item_status, payout_batch_id, reconciliation_needed, public_key, signature, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17);`,
          [
            fullReceipt.receiptId,
            seqIndex.toString(),
            prevHash,
            hash,
            fullReceipt.mandateId,
            fullReceipt.requestId,
            fullReceipt.decision,
            JSON.stringify(fullReceipt.reasonCodes || []),
            Boolean(fullReceipt.paypalCalled),
            fullReceipt.paypalRef || null,
            fullReceipt.batchStatus || null,
            fullReceipt.payoutItemStatus || null,
            fullReceipt.payoutBatchId || null,
            Boolean(fullReceipt.reconciliationNeeded),
            fullReceipt.publicKey,
            fullReceipt.signature,
            JSON.stringify(fullReceipt)
          ]
        );

        await client.query('COMMIT;');
        return {
          ...fullReceipt,
          hash
        };
      } catch (err) {
        await client.query('ROLLBACK;');
        throw err;
      }
    });
  }

  async getReceipts({ requestId, limit = 50, offset = 0 } = {}) {
    return await this._withClient(async (client) => {
      let query = `SELECT * FROM ${this._t('payguard_receipts')}`;
      const params = [];
      if (requestId) {
        query += ' WHERE request_id = $1';
        params.push(requestId);
      }
      query += ' ORDER BY seq_index ASC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2) + ';';
      params.push(limit, offset);

      const res = await client.query(query, params);
      return res.rows.map(r => typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload);
    });
  }

  async getLatestReceipt() {
    return await this._withClient(async (client) => {
      const res = await client.query(
        `SELECT * FROM ${this._t('payguard_receipts')} ORDER BY seq_index DESC LIMIT 1;`
      );
      if (res.rows.length === 0) return null;
      return typeof res.rows[0].payload === 'string' ? JSON.parse(res.rows[0].payload) : res.rows[0].payload;
    });
  }

  async verifyReceiptChain() {
    return await this._withClient(async (client) => {
      const res = await client.query(
        `SELECT * FROM ${this._t('payguard_receipts')} ORDER BY seq_index ASC;`
      );

      const rows = res.rows;
      if (rows.length === 0) {
        return { valid: true, count: 0, reason: 'EMPTY_LOG' };
      }

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        const expectedPrevHash = i === 0 ? '0'.repeat(64) : rows[i - 1].hash;

        // 1. Hash chain check
        if (row.prev_hash !== expectedPrevHash) {
          return {
            valid: false,
            count: rows.length,
            brokenAt: i,
            reason: `PREV_HASH_MISMATCH: Row at index ${i} prev_hash does not match previous row hash`
          };
        }

        // 2. Row hash recomputation
        const computedHash = computeReceiptHash(extractHashableData(payload));
        if (computedHash !== row.hash) {
          return {
            valid: false,
            count: rows.length,
            brokenAt: i,
            reason: `PAYLOAD_TAMPERED: Row at index ${i} computed hash does not match stored hash`
          };
        }

        // 3. Ed25519 signature verification
        try {
          const { signature, publicKey, seq_index, prev_hash, hash, ...signedPayload } = payload;
          const isSignatureValid = crypto.verify(
            null,
            Buffer.from(JSON.stringify(signedPayload)),
            row.public_key,
            Buffer.from(row.signature, 'base64')
          );
          if (!isSignatureValid) {
            return {
              valid: false,
              count: rows.length,
              brokenAt: i,
              reason: `SIGNATURE_INVALID: Row at index ${i} signature verification failed`
            };
          }
        } catch (err) {
          return {
            valid: false,
            count: rows.length,
            brokenAt: i,
            reason: `SIGNATURE_VERIFY_ERROR: ${err.message}`
          };
        }
      }

      return { valid: true, count: rows.length, reason: 'OK' };
    });
  }
}
