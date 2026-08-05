# Prompt 03 — Concurrency and Failure Review

**Role:** Staff engineer specializing in financial correctness and messaging reliability.

## Context

Wallet concurrency strategy: conditional SQL

```sql
UPDATE wallet_accounts
SET available = available - :amount, reserved = reserved + :amount
WHERE user_id = :userId AND asset = :asset AND available >= :amount;
```

Idempotency: unique `(scope, idempotency_key)`, scope = `POST:/quotes/:quoteId/accept`.
Outbox: accept TX inserts event; publisher marks published after RabbitMQ publish.
Consumer: `processed_messages(event_id)`; fake exchange memoized by `clientOrderId = eventId`.
Exchange outcomes: SUCCESS (commit+credit), FAILURE (release), UNKNOWN (REQUIRES_RECONCILIATION,
hold reservation).

## Constraints

- In-memory mutex alone is forbidden; Redis lock alone is insufficient.
- Do not propose Kafka, sagas, or event sourcing.
- Do **not** generate implementation code.
- Assume at-least-once delivery and possible process crashes.

## Tasks

Build a race / failure matrix covering at least:

1. Two concurrent accepts, 80+80 vs 100 USDT.
2. Duplicate HTTP accept with same Idempotency-Key.
3. Concurrent same key.
4. Quote expires during accept.
5. Outbox publish fails after accept commit.
6. Publish succeeds, mark-published crashes → duplicate broker message.
7. Consumer processes twice.
8. Exchange SUCCESS then worker crashes before DB commit.
9. Settlement commits but RabbitMQ ack fails.
10. Exchange UNKNOWN then automatic redelivery.
11. Conflicting execution result after COMPLETED.

For each: what breaks without protection, what mechanism protects it, residual risk.

## Output format

Table or numbered list: Scenario | Risk | Mitigation | Residual.
Then top 5 tests that must exist before calling the system “correct”.

## Verification

Every Critical residual risk must map to either an ADR trade-off or an automated test.
