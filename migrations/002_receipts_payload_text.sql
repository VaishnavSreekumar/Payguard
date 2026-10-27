-- Migration 002: Ensure receipts payload is stored as verbatim TEXT
-- Prevents PostgreSQL JSONB key-reordering from altering cryptographic hashes
ALTER TABLE payguard_receipts ALTER COLUMN payload TYPE TEXT;
