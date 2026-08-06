# Domain Model

## Ubiquitous language

| Term            | Meaning                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Quote           | Short-lived priced offer to convert `sourceAmount` of one asset into another                                                       |
| Accept          | Client command that locks a quote, reserves funds, and starts a conversion                                                         |
| Conversion      | Lifecycle record of one accepted quote through execution to a terminal state                                                       |
| WalletAccount   | Per-user, per-asset balance holder with `balance`, `available`, `reserved`                                                         |
| Reservation     | Amount held in a wallet's aggregate `reserved` balance for an accepted conversion                                                  |
| Money           | Exact decimal amount tagged with an asset; never JS `number`                                                                       |
| Asset           | Registered currency/crypto code with a fixed scale (USDT=6, BTC=8)                                                                 |
| ExchangeRate    | Deterministic source→target rate used when creating a quote                                                                        |
| Outbox message  | Integration event persisted in the same TX as the business write                                                                   |
| Idempotency key | Globally unique client key for the accept operation, with operation scope and request fingerprint stored for audit/reuse detection |

## Aggregates

### Quote (Pricing context)

- **Root:** `Quote`
- **Consistency:** expiry, single accept, `acceptedAt` audit field
- **Statuses:** `ACTIVE` | `ACCEPTED` | `EXPIRED` (`EXPIRED` is derived via `statusAt(now)` when TTL elapsed and not accepted)
- **Rules:** cannot accept after `expiresAt`; cannot accept twice; source amount must be positive; source ≠ target asset

### WalletAccount (Wallet context)

- **Root:** `WalletAccount` (identity: user + asset, persisted with UUID id)
- **Consistency:** `available + reserved = balance`; `available ≥ 0`; `reserved ≤ balance`
- **Methods:** `reserve`, `release`, `commitReservation`, `credit`
- **DB enforcement:** conditional `UPDATE … WHERE available >= :amount` (and analogous
  predicates for release/commit) plus PostgreSQL `CHECK` constraints for non-negative and
  balance-consistency invariants

### Conversion (Conversion context)

- **Root:** `Conversion`
- **Consistency:** state machine only — wallet mutations are coordinated by the application layer
- **Statuses:** `CREATED` → `FUNDS_RESERVED` → `EXECUTION_REQUESTED` → `COMPLETED` \| `FAILED` \| `REQUIRES_RECONCILIATION`
- **Rules:** invalid transitions throw; duplicate identical terminal results are no-ops; conflicting results after a hard terminal state throw `ConflictingExecutionResultError`

### Why Wallet ≠ Conversion

One wallet is shared across many conversions. Folding them into one aggregate would serialize
unrelated operations and blur ownership. The application layer coordinates both inside **one
PostgreSQL transaction** on accept (modular-monolith advantage).

### Why no separate Reservation aggregate

The challenge lists `Reservation` as an expected concept. Here it has no independent lifecycle or
identifier. The accepted `Conversion.sourceAmount` records what that conversion reserved, while
`WalletAccount.reserved` stores the aggregate held amount across conversions. Settlement uses the
conversion amount to commit or release that hold. This avoids an anemic pass-through entity; the
trade-off is that the wallet row alone cannot enumerate individual reservations.

## Entities

Within aggregates, persistence identity is carried by roots (`Quote.id`, `WalletAccount.id`,
`Conversion.id`). Supporting tables (`idempotency_records`, `outbox_messages`,
`processed_messages`) are infrastructure/application concerns, not domain entities.

## Value objects

| VO                                  | Role                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| `Money`                             | Immutable `decimal.js` amount + asset; scale-checked; cross-asset arithmetic forbidden |
| `Asset`                             | Code + scale registry                                                                  |
| `UserId`, `QuoteId`, `ConversionId` | Typed identifiers                                                                      |
| `ExchangeRate`                      | Pair rate used by pricing                                                              |
| Outbox payload fields               | Decimal strings at the boundary                                                        |

`decimal.js` is configured once at process start: `precision: 40`, `ROUND_HALF_EVEN`. Quote
conversion to target scale uses `ROUND_DOWN`.

## Domain events (integration)

Persisted via transactional outbox (not an in-process domain-event bus):

- **`ConversionExecutionRequested`** — written on accept; published to RabbitMQ; consumed by the
  execution worker. Payload includes `eventId` (also used as fake-exchange `clientOrderId`).

In-process domain events are not used; the outbox row is the durable integration event.

## Invariants (mapped to enforcement)

| #   | Invariant                                                                                | Enforcement                                                              |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | Expired quote cannot be accepted                                                         | `Quote.accept(now)`                                                      |
| 2   | Quote accepted only once                                                                 | `Quote.accept` + DB unique accept transition                             |
| 3   | Same idempotency key cannot create multiple conversions or be reused for another request | Global unique key + request fingerprint + replay                         |
| 4   | Available balance never negative                                                         | Domain + conditional SQL + DB `CHECK`                                    |
| 5   | Reserved ≤ balance                                                                       | Domain invariant + DB `CHECK` enforcing `available + reserved = balance` |
| 6   | Same execution event cannot settle twice                                                 | `processed_messages(event_id)`                                           |
| 7   | Completed conversion cannot return to a previous state                                   | Terminal guards + conflict error                                         |
| 8   | Failed conversion releases reservation                                                   | `ProcessConversionExecutionUseCase` + `release`                          |
| 9   | No JS float money                                                                        | `Money` / `NUMERIC` / API strings                                        |

## State transitions

See also the Mermaid state diagram in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

| From                      | To                        | Trigger                                                                                                                         |
| ------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| —                         | `CREATED`                 | Accept starts                                                                                                                   |
| `CREATED`                 | `FUNDS_RESERVED`          | Wallet reserve succeeds (same TX)                                                                                               |
| `FUNDS_RESERVED`          | `EXECUTION_REQUESTED`     | Consumer binds execution to the consumed `eventId`                                                                              |
| `EXECUTION_REQUESTED`     | `COMPLETED`               | Exchange `SUCCESS` → commit + credit                                                                                            |
| `EXECUTION_REQUESTED`     | `FAILED`                  | Exchange `FAILURE` → release                                                                                                    |
| `EXECUTION_REQUESTED`     | `REQUIRES_RECONCILIATION` | Exchange `UNKNOWN` — reservation held                                                                                           |
| `REQUIRES_RECONCILIATION` | `COMPLETED` / `FAILED`    | Domain allows ops resolution; automatic redelivery of the same `eventId` remains a no-op after `processed_messages` is recorded |
