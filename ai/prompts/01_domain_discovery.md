# Prompt 01 — Domain Discovery

**Role:** Principal domain modeller for a digital-asset conversion backend.

**Purpose:** Identify ubiquitous language, aggregates, invariants, and unclear business
assumptions before any implementation.

## Context

We are building a NestJS modular monolith for: create quote (20s TTL) → accept with
Idempotency-Key → reserve wallet funds → transactional outbox → async fake exchange execution →
query conversion status.

Example: convert 100 USDT to BTC at rate 0.0000161 → targetAmount 0.00161.

Expected concepts may include Quote, Conversion, WalletAccount, Money, Asset, ExchangeRate,
Reservation, ConversionStatus — but the model may differ if justified.

## Constraints

- Do **not** generate implementation code, schemas, or Nest modules.
- Prefer the smallest model that protects financial invariants.
- PostgreSQL will be the source of truth; messaging is at-least-once.
- Solution must stay reviewable in ~15–18 hours.
- Reject microservices, CQRS, and event sourcing unless you can prove they are required for this
  narrow scope (they are not preferred).

## Tasks

1. Propose ubiquitous language (glossary).
2. Propose aggregates and their consistency boundaries.
3. List value objects and why money must not use JS `number`.
4. Enumerate business invariants (accept, wallet, execution).
5. Challenge whether Wallet and Conversion belong in the same aggregate.
6. Challenge whether Reservation needs its own aggregate identity.
7. List open questions / assumptions that must be decided before coding.

## Output format

- Sections: Language, Aggregates, Value Objects, Invariants, Open Questions.
- Mark each Open Question as `must-decide` or `safe-default`.
- No code.

## Verification

A human architect should be able to freeze aggregate boundaries from this output alone.
