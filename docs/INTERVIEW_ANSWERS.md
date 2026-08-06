# Interview Answer Sheet

Concise answers to the challenge's §23 follow-up questions, grounded in the implemented code.

## 1. Why these aggregate boundaries?

`Quote` owns price validity and accept-once rules. `WalletAccount` owns one user's balance for one
asset. `Conversion` owns execution lifecycle. Each boundary groups invariants that must change
together without making a shared wallet part of every conversion.

## 2. Why is Wallet not part of Conversion?

One wallet participates in many conversions. Nesting it under one conversion would duplicate or
serialize shared balance state. The application service coordinates both aggregates inside one
PostgreSQL transaction while each aggregate retains its own rules.

## 3. Where is the non-negative balance invariant enforced?

At three layers: `WalletAccount` domain guards, conditional repository updates such as
`WHERE available >= amount`, and PostgreSQL `CHECK` constraints requiring non-negative fields and
`available + reserved = balance`.

## 4. What happens when two accepts execute concurrently?

The database serializes the competing predicate updates. Against 100 USDT, two 80 USDT reserves
cannot both match `available >= 80`; one transaction creates one conversion/outbox/idempotency
record, while the loser rolls back and its quote remains active.

## 5. What if the transaction commits but the message is not published?

The committed outbox row remains unpublished. The poller retries until a RabbitMQ publisher
confirm is received, then sets `publishedAt`. Pending-row metrics expose lag. A crash after broker
confirm but before the database update may duplicate delivery, which consumer idempotency absorbs.

## 6. What if the consumer processes the event twice?

`processed_messages.event_id` is unique and settlement shares its transaction with wallet and
conversion writes. Sequential and concurrent duplicates therefore cannot double debit or credit.
The fake exchange also returns the PostgreSQL-persisted result for the same client order ID.

## 7. What if exchange succeeds but the worker crashes before saving?

The fake exchange result is already durable by `eventId`. Redelivery receives the same result and
retries the settlement transaction. With a real venue, the same event ID would be the client order
ID and the worker would query order status before attempting another order.

## 8. Why optimistic or pessimistic concurrency?

Neither a version-column retry loop nor a broad explicit row lock is the primary mechanism. A
single conditional `UPDATE` is atomic and pessimistically locks the affected row only for the
statement/transaction while encoding the funds predicate directly.

## 9. What changes under very high wallet contention?

Measure conflict rate first. For genuinely hot wallets, use explicit `SELECT ... FOR UPDATE` to
queue contenders, shorten transactions further, and partition work by wallet key. Keep the
PostgreSQL invariant; do not replace it with an in-memory or Redis-only lock.

## 10. Which AI output was technically incorrect?

Early output treated RabbitMQ `publish()` as proof of broker acceptance and used process-local
fake-exchange memoization. The audit rejected both: publication now uses confirms, and exchange
outcomes are persisted. Another output invented a `ReservationId = ConversionId` that the model
does not implement; the corrected design uses the conversion amount plus the wallet's aggregate
reserved balance.

## 11. Which prompt was most valuable?

The concurrency/failure review. It converted vague reliability goals into concrete races:
80+80 against 100, publish-before-mark duplication, exchange-success-before-settlement crash,
duplicate delivery, and UNKNOWN reconciliation. Those scenarios drove both ADRs and tests.

## 12. How was AI overengineering prevented?

The architecture was frozen before implementation. Standing rules prohibited microservices,
Kafka, Redis locking, CQRS, event sourcing, sagas, placeholder abstractions, and unrelated
refactors. Each stage listed files, implemented one scope, ran evidence-based checks, and stopped
for human review.

## 13. Which decision was human-owned?

Keeping a modular monolith with conditional SQL reservation and a folded reservation concept.
AI proposed alternatives, but the candidate approved the boundaries and required proof through
database constraints, rollback tests, and concurrency tests.

## 14. What changes before Pooleno production?

Add authentication/authorization, secret management and TLS; replace the fake exchange with an
idempotent venue adapter and status-reconciliation workflow; operate API and workers separately;
move cleanup to a monitored job; add DLQ tooling/alerts, tracing, SLOs, backups, migration rollback
procedures, load/soak tests, and an operator path for `REQUIRES_RECONCILIATION`.

## 15. How would this integrate with a legacy NestJS application?

Import the bounded-context modules behind their existing ports rather than copying domain logic.
Apply Prisma migrations through the legacy deployment pipeline, map legacy identity/auth at the
HTTP boundary, check route/provider-token collisions, and roll out publisher/consumer loops
behind configuration flags. Contract and migration tests would precede enabling asynchronous
execution.
