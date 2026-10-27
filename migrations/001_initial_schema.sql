-- Migration 001: Initial PayGuard Persistence Schema
-- Supports Neon Postgres durable state across container restarts

-- Schema version tracking
CREATE TABLE IF NOT EXISTS payguard_schema_migrations (
    version INT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 1. Payout Ledger & Idempotency Claims
CREATE TABLE IF NOT EXISTS payguard_ledger (
    request_id VARCHAR(128) PRIMARY KEY,
    agent_id VARCHAR(128) NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'USD',
    spend_date DATE NOT NULL,
    status VARCHAR(32) NOT NULL, -- 'CLAIMED', 'ALLOWED', 'BLOCKED', 'NEEDS_RECONCILIATION', 'RELEASED'
    decision VARCHAR(32),        -- 'ALLOW', 'BLOCK', 'REQUIRE_APPROVAL'
    reason_codes JSONB,
    paypal_called BOOLEAN NOT NULL DEFAULT FALSE,
    paypal_ref VARCHAR(128),
    batch_status VARCHAR(64),
    item_status VARCHAR(64),
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payguard_ledger_agent_date ON payguard_ledger(agent_id, spend_date);
CREATE INDEX IF NOT EXISTS idx_payguard_ledger_status ON payguard_ledger(status);

-- Dedicated atomic daily spend reservation table with row-level locking
CREATE TABLE IF NOT EXISTS payguard_agent_daily_spend (
    agent_id VARCHAR(128) NOT NULL,
    spend_date DATE NOT NULL,
    total_spend NUMERIC(12, 2) NOT NULL DEFAULT 0,
    PRIMARY KEY (agent_id, spend_date)
);

-- 2. Human Approvals Workflow
CREATE TABLE IF NOT EXISTS payguard_approvals (
    approval_id VARCHAR(128) PRIMARY KEY,
    request_id VARCHAR(128) NOT NULL,
    status VARCHAR(32) NOT NULL, -- 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'
    risk_level VARCHAR(32) NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    merchant_name VARCHAR(255) NOT NULL,
    reason TEXT NOT NULL,
    policy_snapshot JSONB NOT NULL,
    payment_request JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ,
    resolution_note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payguard_approvals_request_id ON payguard_approvals(request_id);
CREATE INDEX IF NOT EXISTS idx_payguard_approvals_status ON payguard_approvals(status);

-- 3. Cryptographic Receipts & Hash-Chain State
CREATE TABLE IF NOT EXISTS payguard_receipts (
    receipt_id VARCHAR(128) PRIMARY KEY,
    seq_index BIGINT NOT NULL UNIQUE,
    prev_hash CHAR(64) NOT NULL,
    hash CHAR(64) NOT NULL,
    mandate_id VARCHAR(128) NOT NULL,
    request_id VARCHAR(128) NOT NULL,
    decision VARCHAR(32) NOT NULL,
    reason_codes JSONB,
    paypal_called BOOLEAN NOT NULL DEFAULT FALSE,
    paypal_ref VARCHAR(128),
    batch_status VARCHAR(64),
    payout_item_status VARCHAR(64),
    payout_batch_id VARCHAR(128),
    reconciliation_needed BOOLEAN NOT NULL DEFAULT FALSE,
    public_key TEXT NOT NULL,
    signature TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payguard_receipts_seq_index ON payguard_receipts(seq_index);
CREATE INDEX IF NOT EXISTS idx_payguard_receipts_request_id ON payguard_receipts(request_id);
