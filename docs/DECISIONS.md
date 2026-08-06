# Architecture Decision Records

## ADR-001 — Wallet concurrency via conditional SQL UPDATE (no version column)

**Status:** Accepted

**Context:** Concurrent quote accepts must not overspend `available`. Spec forbids an in-memory
mutex as the sole control and rejects Redis-only locks without DB protection.

**Decision:** Enforce reserve with a single atomic statement:

```sql
UPDATE wallet_accounts
SET available = available - :amount,
    reserved  = reserved + :amount
WHERE user_id = :userId
  AND asset = :asset
  AND available >= :amount;
```

Zero rows updated ⇒ insufficient funds or lost race. Domain `WalletAccount.reserve()` still
enforces the invariant in memory before/after mapping. No optimistic `version` column.

**Consequences:**

- Pros: invariant encoded in the DB predicate; short critical section; simple to review.
- Cons: under extreme same-wallet contention losers fail fast (conflict/insufficient) rather
  than queue behind a lock.

**Alternatives considered:** `SELECT … FOR UPDATE` (see ADR-004); optimistic version column
(extra complexity without stronger guarantee than the predicate); Redis lock (insufficient alone).

---

## ADR-002 — Transactional outbox + consumer idempotency

**Status:** Accepted

**Context:** Accept must not dual-write to DB and broker. At-least-once delivery is assumed.

**Decision:**

1. Accept TX writes business rows + `outbox_messages`.
2. Batched publisher (`LIMIT` configurable) uses persistent messages and publisher confirms,
   then marks `publishedAt`.
3. Consumer records `processed_messages(event_id)` uniquely before/with settlement.
4. Fake exchange outcomes are persisted by `clientOrderId = eventId` so simulation remains stable
   across retries and process restarts.
5. Consumer failures are republished with a bounded retry header; exhausted messages are routed
   to a dead-letter queue.

**Consequences:**

- Pros: no lost events on accept commit; safe redelivery; residual duplicate publish after
  crash-between-publish-and-mark is handled by consumer idempotency.
- Cons: outbox poller lag; publisher must retry transient broker failures
  (`outbox_publish_failure_total`).

**Alternatives considered:** Direct publish in accept TX (dual-write); inbox-only without outbox
(event loss on crash after commit).

---

## ADR-003 — Modular monolith vs microservices

**Status:** Accepted

**Context:** Spec prefers a modular monolith when it clarifies transactional consistency.

**Decision:** One Nest deployable with three bounded contexts (`pricing`, `wallet`, `conversion`)
plus `shared`. Accept coordinates contexts inside one PostgreSQL Unit of Work.

**Consequences:**

- Pros: ACID accept (quote + wallet + conversion + outbox); simpler ops for a challenge-sized
  system; clear module folders for review.
- Cons: process-level coupling of API and workers (acceptable here; can split workers later
  without changing aggregate boundaries).

**Rejected:** Microservices for this scope — weaker local TX for accept+reserve+outbox; more
moving parts than a 15–18h reviewable submission warrants.

---

## ADR-004 — Conditional UPDATE vs `SELECT … FOR UPDATE`

**Status:** Accepted

**Context:** Pessimistic row locking is a valid Postgres strategy; we needed an explicit choice.

**Decision:** Prefer a single predicate UPDATE (`available >= :amount`) as the concurrency
primitive for reserve/release/commit. Do not hold row locks across application logic for the
happy path.

**Rationale:** The UPDATE predicate already encodes the business rule. Accept/settle
transactions are narrow. Failed updates surface as insufficient-funds/conflict errors, which
matches the product expectation that only one of two competing 80 USDT reserves against 100
succeeds.

**Trade-off / scale-up path:** Under extreme wallet contention, switch hot paths to
`SELECT … FOR UPDATE` (or shard wallets) so losers wait instead of failing fast. No CQRS, no
event sourcing, no Redis locking introduced for this challenge.

**Consequences:** Documented in README limitations; concurrency integration tests prove the
80+80 vs 100 case.

---

## ADR-005 — Globally unique HTTP idempotency keys with bounded retention

**Status:** Accepted

**Context:** A client key reused for another quote must not create a second conversion, even if
the endpoint's logical scope string is unchanged. Completed records also need bounded retention.

**Decision:** `idempotency_key` is globally unique. Each record stores the operation scope and a
SHA-256 request fingerprint; same-key/same-fingerprint requests replay the stored response, while
same-key/different-fingerprint requests return `IDEMPOTENCY_KEY_REUSE`. Completed records older
than 24 hours are deleted in bounded batches; in-progress records are retained.

**Consequences:**

- Pros: simple client contract; no cross-quote key reuse; deterministic replay; bounded table
  growth.
- Cons: clients cannot intentionally reuse a key for another operation after completion until
  retention removes it; the in-process cleanup loop should become a separately monitored job in
  a larger deployment.
