-- Migration 003: Dedicated atomic spend cap reservation table with row-level locking
-- Provides airtight concurrent spend serialization under PgBouncer connection pooling
CREATE TABLE IF NOT EXISTS payguard_agent_daily_spend (
    agent_id VARCHAR(128) NOT NULL,
    spend_date DATE NOT NULL,
    total_spend NUMERIC(12, 2) NOT NULL DEFAULT 0,
    PRIMARY KEY (agent_id, spend_date)
);
