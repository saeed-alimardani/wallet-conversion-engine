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
2. Batched publisher (`LIMIT` configurable) publishes then marks `publishedAt`.
3. Consumer records `processed_messages(event_id)` uniquely before/with settlement.
4. Fake exchange memoizes by `clientOrderId = eventId` so external simulation is stable on retry.

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
