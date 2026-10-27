# PayGuard

**Pre-Payment Authorization Firewall & Verification Prototype for Agentic Commerce**

PayGuard is a pre-payment authorization gateway designed to protect corporate funds when autonomous AI agents execute commercial tasks. PayGuard decouples untrusted AI agents from payment credentials, enforcing deterministic spending mandates, authoritative merchant registry checks, and cumulative daily budget limits before disbursing funds via PayPal.

---

## Core Architecture

PayGuard operates on a zero-trust model where AI output is strictly untrusted input:

```
[ Untrusted AI Agent ]
        │  (Payment Request via MCP / API)
        ▼
[ PayGuard Firewall ]
  ├── 1. Cryptographic Mandate Verification (Ed25519 signature against Admin Public Key)
  ├── 2. Authoritative Merchant Registry (Payee email locked by platform; ignores proposal email)
  ├── 3. Deterministic Decision Engine (Caps, daily budgets, category restrictions)
  └── 4. Tamper-Evident Evidence Log (SHA-256 hash-chained log signed with Gateway Key)
        │
        ▼ (Only if decision is ALLOW)
[ PayPal Settlement ]
  └── Programmatic Balance Disbursement (POST /v1/payments/payouts with deterministic sender_batch_id)
```

1. **Zero Credential Exposure**: Autonomous agents never possess PayPal client IDs, client secrets, or OAuth bearer tokens.
2. **Deterministic Precedence**: The decision to `ALLOW`, `REQUIRE_APPROVAL`, or `BLOCK` is computed solely by compiled deterministic rules. LLM advisory risk analysis can escalate risk but can never override hard limits.
3. **Authoritative Recipient Binding**: Payee addresses are resolved strictly from the platform's trusted merchant registry. Recipient emails injected into invoices or payment proposals are ignored and flagged.
4. **Idempotent Settlement**: Each transaction derives deterministic idempotency keys (`sender_batch_id` and `PayPal-Request-Id`) from the unique PayGuard request ID.

---

## Measured PayPal Sandbox Payout Replay Behavior

On October 26, 2026, a live sequential replay experiment was conducted against the PayPal Sandbox REST API (`https://api-m.sandbox.paypal.com/v1/payments/payouts`). The raw non-secret experiment data is preserved in [`artifacts/paypal-replay-replay_1793034488271_fjuk.json`](./artifacts/paypal-replay-replay_1793034488271_fjuk.json).

### Measured Sequence:
1. **Attempt 1 (`POST /v1/payments/payouts`)**:
   - Sent payout request with `sender_batch_id: "batch_replay_1793034488271"` and `PayPal-Request-Id: "req_idempotent_1793034488271"` for $1.00 USD.
   - Result: **HTTP 201 Created**. Returned `payout_batch_id: "UEN7JGPA69ZM6"`, status `PENDING`.
2. **Attempt 2 (Identical Sequential Replay)**:
   - Resubmitted the exact same request body, headers, and identifiers.
   - Result: **HTTP 400 Bad Request (`USER_BUSINESS_ERROR`)**.
   - Raw error issue: `"Batch with given sender_batch_id already exists"`.
   - Included HATEOAS link to the existing batch: `https://api.sandbox.paypal.com/v1/payments/payouts/UEN7JGPA69ZM6`.
3. **Batch Verification (`GET /v1/payments/payouts/UEN7JGPA69ZM6`)**:
   - Querying the batch details confirmed a single batch was created.
   - Payout item `EF4N3DJDCJ4H2` transitioned to `SUCCESS` with live PayPal transaction ID `4U2364973D3153322` and fee `$0.02 USD`.

### Measured Conclusion:
Replaying a payout request with an existing `sender_batch_id` does not return the original HTTP 201 response. Instead, PayPal rejects the duplicate with HTTP 400 and references the existing batch. PayGuard's [`PayPalPayoutsProcessor`](./src/paypal_adapter.js) catches this specific error condition, extracts the existing batch ID, and recovers the original batch representation without double-paying.

---

## Frequently Asked Questions & Judge Q&A

### Q1: Does PayGuard guarantee that duplicate payouts are impossible?
> **Answer**: No. We do not claim an absolute guarantee that duplicate payouts are impossible under all theoretical distributed systems failures. Instead, PayGuard implements defense-in-depth:
> 1. An internal synchronous claim ledger ([`src/ledger.js`](./src/ledger.js)) rejects duplicate request IDs locally before any network dispatch occurs.
> 2. Outbound PayPal calls use deterministic `sender_batch_id` values derived via SHA-256 from the request ID.
> 3. If a network timeout occurs and a retry is dispatched, PayPal's API enforces batch ID uniqueness and returns HTTP 400, which PayGuard safely recovers without creating a new batch.

### Q2: What prevents an attacker from injecting their PayPal email into an invoice?
> **Answer**: PayGuard's Authoritative Merchant Registry ([`src/merchant_registry.js`](./src/merchant_registry.js)). The gateway strictly ignores any payout email present in invoice text or agent proposals. Payee addresses are resolved exclusively from the platform-configured merchant registry. If an agent attempts to pass an unverified email, the registry flags `recipientOverrideAttempt: true` and retains the authoritative email.

### Q3: Why does the configured Sandbox recipient use `personal.example.com`?
> **Answer**: In PayPal's Sandbox environment, accounts generated via the PayPal Developer Dashboard are assigned simulated addresses under the `@personal.example.com` domain. PayPal Sandbox does not route external emails across the public internet. PayGuard requires this email to be supplied via `PAYPAL_PAYOUT_RECIPIENT_EMAIL` and fails closed if the variable is missing or blank.

### Q4: How is the evidence chain protected against tampering?
> **Answer**: Every decision is appended to a SHA-256 hash-chained log (`payguard_receipts.jsonl`). Each block includes the hash of the preceding block and is signed with the gateway's Ed25519 private key. Mutating any byte of historical audit records breaks the hash chain and causes signature verification to fail immediately.

---

## Configuration & Setup

### Environment Variables
Copy `.env.example` to `.env` and fill in your Sandbox credentials:
```bash
PAYPAL_CLIENT_ID=your_sandbox_client_id
PAYPAL_CLIENT_SECRET=your_sandbox_client_secret
PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com
PAYPAL_PAYOUT_RECIPIENT_EMAIL=your-sandbox-personal-email@personal.example.com
DATABASE_URL="postgresql://user:password@ep-your-pooler.region.aws.neon.tech/neondb?sslmode=require"
```

### Database Migrations (Neon Postgres)
PayGuard tracks schema evolution using versioned SQL migrations stored in `migrations/`:
```bash
# Run pending migrations against the configured DATABASE_URL
npm run migrate
```

Migrations define:
- `payguard_ledger`: Atomic request idempotency claims and status lifecycles.
- `payguard_agent_daily_spend`: Dedicated daily budget accounting table with row-level transaction locks (`SELECT ... FOR UPDATE`) compatible with PgBouncer.
- `payguard_approvals`: Atomic pending human approval records, expiration, and resolution state.
- `payguard_receipts`: Append-only cryptographic ledger storing sequence numbers, SHA-256 hashes, previous-hash links, and Ed25519 signatures with raw text payload preservation.

### Running Automated Tests
PayGuard includes deterministic offline tests and live database integration suites:
```bash
# Run standard offline regression tests (84/84 tests, memory adapter)
npm test

# Run Neon Postgres persistence & concurrency integration tests (isolated schema)
npm run test:db

# Run complete test suite (offline, adversarial, API, and DB persistence)
npm run test:all
```

