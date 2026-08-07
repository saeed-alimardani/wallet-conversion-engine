# End-to-end flow (worked example)

Concrete walkthrough of the conversion path using the seeded demo user
`user-123` converting **100 USDT → BTC** at the deterministic fake rate
`0.0000161` → target **0.00161 BTC**.

This document is a narrative companion to [`ARCHITECTURE.md`](./ARCHITECTURE.md),
[`DOMAIN_MODEL.md`](./DOMAIN_MODEL.md), and [`FAILURE_SCENARIOS.md`](./FAILURE_SCENARIOS.md).
It does not change architecture; it explains what already runs.

---

## What the system is

NestJS modular monolith. One process runs the HTTP API, the outbox publisher, and
the RabbitMQ execution consumer. PostgreSQL is the source of truth for money and
business state. RabbitMQ only carries the “please execute this conversion” signal
after accept has already committed.

There is no public create-wallet API. Wallets are funded by seed / test helpers.

Domain aggregates:

- **Quote** — short-lived price offer
- **WalletAccount** — one row per `(userId, asset)` with `balance` / `available` / `reserved`
- **Conversion** — lifecycle/state machine only; wallet mutations are coordinated by the
  application layer inside explicit transactions

Infrastructure tables (not domain aggregates): `idempotency_records`, `outbox_messages`,
`processed_messages`, `fake_exchange_executions`.

Wallet invariant: `available + reserved = balance`.

---

## Step 0 — World before any API call

```bash
npm run prisma:seed
```

Seed opens two wallets for `user-123` via `WalletAccount.open`, then upserts
`wallet_accounts`:

1. USDT: `balance = 100`, `available = 100`, `reserved = 0`
2. BTC: `balance = 0`, `available = 0`, `reserved = 0`

At this moment `quotes`, `conversions`, `outbox_messages`, `idempotency_records`,
`processed_messages`, and `fake_exchange_executions` are empty (for this demo path).

---

## Step 1 — Create quote

### Input

```http
POST /quotes
Content-Type: application/json
```

```json
{
  "userId": "user-123",
  "sourceAsset": "USDT",
  "targetAsset": "BTC",
  "sourceAmount": "100"
}
```

`sourceAmount` is a decimal **string** (not a JSON number).

### Processing

1. Parse into domain value objects (`UserId`, `Asset`, `Money`).
2. `FakePricingProvider.getRate(USDT, BTC)` returns fixed rate `0.0000161`.
3. `Quote.create` computes target with ROUND_DOWN:

   `100 × 0.0000161 = 0.00161 BTC`

4. TTL = 20 seconds (`QUOTE_TTL_SECONDS`). Status = `ACTIVE`.
5. Persist.

### Database write

**INSERT `quotes`** — e.g. id `q-111`, status `ACTIVE`, `accepted_at` NULL,
`expires_at = created_at + 20s`. Rate and amounts as above.

No wallet / conversion / outbox writes.

### Output

HTTP `201`:

```json
{
  "quoteId": "q-111",
  "sourceAsset": "USDT",
  "targetAsset": "BTC",
  "sourceAmount": "100",
  "targetAmount": "0.00161",
  "rate": "0.0000161",
  "expiresAt": "2026-08-07T10:00:20.000Z",
  "status": "ACTIVE"
}
```

(`expiresAt` illustrative.) HTTP trims trailing zeros on decimal strings.

USDT wallet is still balance 100 / available 100 / reserved 0.

---

## Step 2 — Accept quote (one PostgreSQL transaction)

### Input

```http
POST /quotes/q-111/accept
Idempotency-Key: accept-key-abc-001
```

No body. Request fingerprint = `SHA-256(quoteId)`.

Everything below runs inside **one** Prisma `$transaction` (`UnitOfWork`).
Business aborts throw `AcceptAbortedError` so the whole TX — including the
idempotency claim — rolls back. Failed accepts do not poison keys.

### 2.1 Claim idempotency

**INSERT `idempotency_records`** (`INSERT … ON CONFLICT DO NOTHING`):

- `scope` = `POST:/quotes/:quoteId/accept`
- `idempotency_key` = `accept-key-abc-001`
- `request_hash` = sha256(`q-111`)
- response fields NULL (in progress)

First request wins. Concurrent same-key loser waits outside the TX (default up to
2000ms) then replays the stored response. Same key + different quote hash →
`409 IDEMPOTENCY_KEY_REUSE`.

### 2.2 Accept quote

**READ `quotes`**. Domain `quote.accept(now)` checks not expired / not already accepted.

**Conditional UPDATE `quotes`:**

```sql
UPDATE quotes
SET status = 'ACCEPTED', accepted_at = :now
WHERE id = :quoteId
  AND status = 'ACTIVE'
  AND expires_at >= :now
```

Zero rows → `QUOTE_ACCEPT_CONFLICT` → full rollback.

Persisted statuses are only `ACTIVE` | `ACCEPTED`. `EXPIRED` is derived when still
ACTIVE but past TTL.

### 2.3 Create conversion (CREATED)

**INSERT `conversions`** — id `c-222`, quote `q-111`, amounts from quote,
status `CREATED`, `exchange_execution_id` NULL.

`CREATED` is ephemeral inside the accept TX; the same TX immediately reserves funds.

### 2.4 Reserve wallet

**Conditional UPDATE `wallet_accounts`** for `(user-123, USDT)`:

```sql
UPDATE wallet_accounts
SET available = available - 100,
    reserved  = reserved + 100
WHERE user_id = 'user-123'
  AND asset = 'USDT'
  AND available >= 100
```

Zero rows → `409 INSUFFICIENT_AVAILABLE_BALANCE` → full rollback.

After success:

- USDT: balance **100**, available **0**, reserved **100** (owned, but held)
- BTC unchanged: all zeros

Reserve does not spend; it only moves available → reserved.

### 2.5 Mark FUNDS_RESERVED and bind event id

Generate event id `e-333`. Same id becomes:

- outbox message id
- conversion `exchange_execution_id`
- fake-exchange `client_order_id`
- later `processed_messages.event_id`

**UPDATE `conversions`:** status `CREATED` → `FUNDS_RESERVED`,
`exchange_execution_id = e-333`.

### 2.6 Write outbox

**INSERT `outbox_messages`** id `e-333`, type `ConversionExecutionRequested`,
`published_at` NULL, payload:

```json
{
  "eventId": "e-333",
  "eventType": "ConversionExecutionRequested",
  "conversionId": "c-222",
  "userId": "user-123",
  "sourceAsset": "USDT",
  "targetAsset": "BTC",
  "sourceAmount": "100",
  "targetAmount": "0.00161",
  "occurredAt": "2026-08-07T10:00:05.000Z"
}
```

### 2.7 Complete idempotency

**UPDATE `idempotency_records`:** `response_status = 201`, store response body,
`conversion_id = c-222`.

### 2.8 Commit + HTTP output

TX commits. HTTP `201`:

```json
{
  "conversionId": "c-222",
  "quoteId": "q-111",
  "userId": "user-123",
  "status": "FUNDS_RESERVED",
  "sourceAsset": "USDT",
  "targetAsset": "BTC",
  "sourceAmount": "100",
  "targetAmount": "0.00161",
  "createdAt": "2026-08-07T10:00:05.000Z"
}
```

Retry with the same `Idempotency-Key` returns this stored body; no second reserve.

Exchange has **not** been called yet. BTC not credited.

---

## Step 3 — Outbox publish (async, outside accept TX)

`OutboxPublisherService` polls unpublished rows:

1. **READ** `outbox_messages` where `published_at IS NULL`
2. Publish persistent JSON to RabbitMQ topic `conversion.execution.requested`
   (exchange `conversion.events`) via confirm channel
3. After broker confirm: **UPDATE** set `published_at`

On broker failure: leave unpublished and retry next poll.

Residual risk: publish OK then crash before marking published → duplicate broker
message. Consumer + fake exchange idempotency absorb it.

---

## Step 4 — Consume, fake exchange, settle

`ExecutionConsumerService` → `ProcessConversionExecutionUseCase`.

### 4.1 Fast duplicate check

**READ `processed_messages`** for `e-333`. If present → no-op, ack.

### 4.2 Advance to EXECUTION_REQUESTED

**Conditional UPDATE `conversions`:**

```sql
UPDATE conversions
SET status = 'EXECUTION_REQUESTED'
WHERE id = 'c-222'
  AND status = 'FUNDS_RESERVED'
  AND exchange_execution_id = 'e-333'
```

Assert payload matches conversion. Wallets still: USDT held (100 reserved), BTC 0.

### 4.3 Fake exchange (own DB writes, outside settlement TX)

`FakeExchangeAdapter.execute({ clientOrderId: e-333, ... })`:

1. Decide a **proposed** outcome from `FAKE_EXCHANGE_MODE` / per-order override
   (default `SUCCESS`).
2. **`createMany` into `fake_exchange_executions` with `skipDuplicates: true`**
   keyed by `client_order_id = e-333`.
3. **`findUniqueOrThrow` by `client_order_id`** and return the **persisted** row’s
   outcome (not a fresh random decision).

First insert wins forever. See [Crash after exchange, before settlement](#crash-after-exchange-before-settlement) below.

Happy path inserts outcome `SUCCESS`.

### 4.4 Settlement TX

One Prisma `$transaction`:

1. **INSERT `processed_messages`** (`event_id = e-333`, outcome `SUCCESS`). Unique claim.
2. Reload conversion.
3. On SUCCESS:
   - `commitReservation(100 USDT)` → USDT balance 0, available 0, reserved 0
   - `createIfMissing` target wallet if needed
   - `credit(0.00161 BTC)` → BTC balance/available `0.00161`
   - conversion → `COMPLETED`, set `completed_at`

Then consumer acks RabbitMQ.

If ack fails and broker redelivers: `processed_messages` short-circuits; no double settle.

### Non-SUCCESS outcomes (after accept already committed)

- **FAILURE:** release USDT reservation (available restored, balance unchanged);
  conversion `FAILED`.
- **UNKNOWN:** no wallet mutate; conversion `REQUIRES_RECONCILIATION`; hold kept.
  Same `eventId` redelivery is a no-op after processed marker. Domain allows later
  ops resolution to COMPLETED/FAILED (no public HTTP ops API in this project).

---

## Step 5 — Query status

### Input

```http
GET /conversions/c-222
```

**READ only** `conversions`.

### Output

```json
{
  "conversionId": "c-222",
  "status": "COMPLETED",
  "sourceAsset": "USDT",
  "targetAsset": "BTC",
  "sourceAmount": "100",
  "targetAmount": "0.00161",
  "createdAt": "2026-08-07T10:00:05.000Z",
  "completedAt": "2026-08-07T10:00:06.123Z"
}
```

Final wallets: USDT all zeros; BTC `0.00161` available/balance.

---

## Crash after exchange, before settlement

This is the important timing:

```
accept TX committed (funds reserved, outbox written)
  → publisher confirmed to RabbitMQ
  → consumer advances conversion to EXECUTION_REQUESTED
  → FakeExchangeAdapter.execute()
       1) INSERT fake_exchange_executions (client_order_id = e-333, outcome = SUCCESS)
          ← this commit is SEPARATE from the settlement TX
       2) READ that row back; return SUCCESS to the use case
  → settlement TX starts (processed_messages + wallet commit/credit + COMPLETED)
  → ★ process crashes here, before settlement commits
  → RabbitMQ redelivers e-333 (or consumer restarts and gets the message again)
```

On the retry, the use case **does call** `exchange.execute(...)` again. That is fine.
“Calling exchange again” here does **not** mean “open a second trade.”

What `FakeExchangeAdapter.execute` does on every call:

1. Build a proposed result in memory (from mode).
2. Try `INSERT` with `skipDuplicates: true` on primary key `client_order_id`.
3. Always `SELECT` the row for that `client_order_id`.
4. Return the **database row’s** `outcome`.

So after the first successful insert of `e-333 → SUCCESS`:

- retry INSERT affects **0** rows (`skipDuplicates`)
- SELECT still finds the original SUCCESS row
- returned outcome is SUCCESS again

The outcome is “the same” because it was **already written to PostgreSQL** in step 4.3,
in its own commit, **before** settlement. The crash you are worried about is a crash
**after** that write and **before** the settlement TX. The exchange result is not
sitting only in process memory; it is durable in `fake_exchange_executions`.

If the crash happened **before** the fake-exchange INSERT committed, there is no prior
SUCCESS in the DB. The retry inserts for the first time. That is also safe: no
earlier “logical trade” existed.

Settlement then runs with the memoized SUCCESS: claim `processed_messages`, commit
USDT reservation, credit BTC, mark COMPLETED.

For a **real** exchange the same idea applies with a venue-side client order id:
use `eventId` as `clientOrderId`, and on retry **query the venue** (or rely on
idempotent create) instead of blindly creating a second order. This project simulates
that durability with the `fake_exchange_executions` table.

Related: [`FAILURE_SCENARIOS.md`](./FAILURE_SCENARIOS.md) §8
(“Consumer crash after external execution”).

---

## Accept-time failures (before accept TX commits)

These roll back everything in the accept unit of work (including the idempotency claim):

- past TTL → `409 QUOTE_EXPIRED`
- already accepted / lost conditional update → accept conflict / already accepted
- insufficient available → `409 INSUFFICIENT_AVAILABLE_BALANCE`
- mid-TX DB failure → full Prisma rollback; client may retry

See [`FAILURE_SCENARIOS.md`](./FAILURE_SCENARIOS.md) for the named catalog and tests.

---

## Continuous story (happy path)

Start: user-123 has 100 free USDT and 0 BTC.

Client posts quote for 100 USDT→BTC. System writes one ACTIVE quote with rate
0.0000161, target 0.00161 BTC, 20-second expiry. Wallets unchanged.

Within those 20 seconds, client accepts with idempotency key `accept-key-abc-001`.
In one database transaction the system claims that key, marks the quote ACCEPTED,
inserts conversion `c-222` as CREATED then FUNDS_RESERVED, moves 100 USDT from
available into reserved, inserts unpublished outbox event `e-333`, stores the 201
response on the idempotency row, and commits. HTTP returns `FUNDS_RESERVED`.
User still owns 100 USDT on paper (`balance` 100) but cannot spend it
(`available` 0, `reserved` 100). BTC still 0.

Background publisher reads unpublished outbox row `e-333`, publishes to RabbitMQ,
waits for confirm, sets `published_at`.

Consumer receives `e-333`, advances conversion to EXECUTION_REQUESTED, persists
fake exchange SUCCESS for `clientOrderId = e-333`, then in a settlement transaction
records `processed_messages`, commits the USDT reservation (USDT → 0), credits
0.00161 BTC, marks conversion COMPLETED, and acks.

Client GETs conversion `c-222` and sees COMPLETED with `targetAmount` 0.00161.
Final wallets: 0 USDT, 0.00161 BTC.
