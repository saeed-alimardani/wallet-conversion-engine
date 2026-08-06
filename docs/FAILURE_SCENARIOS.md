# Failure Scenarios

How the system handles each named scenario from the challenge spec.

## 1. Quote expires during acceptance

**What happens:** Client accepts after the 20s TTL (or `expiresAt` is already in the past).

**Handling:** Inside the accept TX, `Quote.accept(now)` throws `QuoteExpiredError`. The use case
maps this to `409 QUOTE_EXPIRED` via `AcceptAbortedError`, rolling back the entire TX including
any idempotency claim. No conversion, outbox row, or wallet mutation remains.

**Test:** `test/accept-failure-paths.integration-spec.ts` — expired quote leaves reserved=0.

## 2. Duplicate HTTP request

**What happens:** Same `Idempotency-Key` is retried on the same quote after a successful accept.

**Handling:** `idempotency_key` is globally unique; the operation scope
`POST:/quotes/:quoteId/accept` and a quote-specific request fingerprint are stored with it.
Winner stores `response_status` + `response_body`. Concurrent same-key losers that observe
`in-progress` wait outside the accept TX (poll, configurable via
`IDEMPOTENCY_IN_PROGRESS_WAIT_MS`) and then replay the stored 201 body so both callers receive
the same logical result. A stuck claim that never completes still returns
`409 IDEMPOTENCY_IN_PROGRESS`. Request hash mismatch → `409 IDEMPOTENCY_KEY_REUSE`.

**Test:** `test/accept-quote.integration-spec.ts` (replay, no double reserve); concurrent same-key
both-201 coverage in `test/accept-concurrency.integration-spec.ts`.

## 3. Concurrent wallet reservation

**What happens:** Two accepts each try to reserve 80 USDT against 100 USDT available.

**Handling:** Conditional SQL `UPDATE … WHERE available >= :amount`. Exactly one UPDATE affects
a row; the other returns 0 rows → `409 INSUFFICIENT_AVAILABLE_BALANCE` (or accept conflict).
Wallet never goes negative; `available + reserved = balance` holds.

**Test:** `test/execution.integration-spec.ts` and `test/wallet-repository.integration-spec.ts`
concurrency cases.

## 4. Database commit failure

**What happens:** Accept TX fails mid-flight (constraint, connection, explicit abort).

**Handling:** Prisma `$transaction` rolls back all writes in that unit of work: idempotency claim,
quote accept, conversion, wallet reserve, outbox. Client receives an error; a later retry with the
same key can proceed (no poisoned in-progress row from a rolled-back claim — claims use
`INSERT … ON CONFLICT DO NOTHING` and business failures abort the TX).

**Test:** `accept-failure-paths.integration-spec.ts` fault-injects an outbox persistence failure
and proves quote, wallet, conversion, outbox, and idempotency writes all roll back.
`execution.integration-spec.ts` fault-injects conversion persistence failure after wallet
settlement operations and proves wallet changes plus the processed-message claim roll back.

## 5. Outbox publication failure

**What happens:** Publisher reads unpublished rows but RabbitMQ publish throws / NACK.

**Handling:** Persistent publication uses a RabbitMQ confirm channel. A NACK, confirm timeout,
connection failure, or backpressure failure leaves `published_at IS NULL`; metric
`outbox_publish_failure_total` increments and the next poll retries. Business state (reserved
funds, conversion `FUNDS_RESERVED`) remains correct until a later confirmed publish + consume.

**Residual risk:** Publish OK then crash before marking published → duplicate broker message;
consumer idempotency absorbs it.

## 6. Duplicate message delivery

**What happens:** RabbitMQ redelivers the same `eventId`, or outbox republishes after a crash.

**Handling:**

1. Fast path: `processed_messages.exists(eventId)` → increment `execution_retry_total`, return.
2. Race: two workers call `tryRecord`; unique constraint lets one claim; the other skips settlement.
3. Fake exchange stores one immutable result per `clientOrderId = eventId` in PostgreSQL, so
   external simulation is identical across concurrent calls and process restarts.
4. Unexpected consumer failures are retried a bounded number of times, then dead-lettered.

Wallet settle/release runs at most once.

**Test:** sequential duplicate process in `execution.integration-spec.ts`; concurrent double
delivery in race suite.

## 7. Exchange timeout (UNKNOWN)

**What happens:** Fake exchange returns `UNKNOWN` (simulated timeout).

**Handling:** Conversion → `REQUIRES_RECONCILIATION`. Reservation is **not** released and **not**
committed. `processed_messages` records `UNKNOWN` so automatic redelivery of the same `eventId`
is a no-op (avoids blind duplicate exchange attempts). Domain allows later ops resolution to
`COMPLETED`/`FAILED`; production would use a unique client order id to query the real venue
before mutating the wallet again.

**Test:** `execution.integration-spec.ts` UNKNOWN case; domain unit tests for reconciliation
transitions.

## 8. Consumer crash after external execution

**What happens:** Fake (or real) exchange already executed for `clientOrderId`, then the worker
dies before committing settlement.

**Handling:** On restart/redelivery, the exchange adapter returns the PostgreSQL-persisted result
for the same `clientOrderId`. Consumer retries settlement TX. If conversion is already terminal but
`processed_messages` is missing, the use case “repairs” by recording the event without
re-settling.

**Design note for a real exchange:** use `eventId` as client order id and query venue status
before creating a new order.

## 9. Execution succeeds but acknowledgement fails

**What happens:** Settlement TX commits (wallet + conversion + processed_messages) but RabbitMQ
ack fails / connection drops → broker redelivers.

**Handling:** Identical to duplicate delivery: `processed_messages` short-circuits; wallet
unchanged. At-least-once + idempotent handler is the intended contract.

## 10. Failed execution requires wallet release

**What happens:** Fake exchange returns `FAILURE`.

**Handling:** In the settlement TX: claim `processed_messages`, `wallets.release(sourceAmount)`,
conversion → `FAILED` with reason. Available balance restored; reserved decreased; total balance
unchanged. Metric `conversion_failed_total` increments.

**Test:** `execution.integration-spec.ts` failure release case.
