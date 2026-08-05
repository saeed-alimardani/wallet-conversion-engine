# Prompt 02 — Architecture Review

**Role:** Principal backend architect reviewing a NestJS modular monolith design (not code).

## Context

The system accepts a short-lived conversion quote, reserves wallet funds, and publishes an
execution request through a transactional outbox to RabbitMQ. A worker calls a fake exchange and
settles or releases the reservation.

Proposed modules: `pricing`, `wallet`, `conversion`, `shared`.
Proposed aggregates: `Quote`, `WalletAccount`, `Conversion`.
Accept runs in one PostgreSQL transaction: idempotency → quote accept → conversion create →
wallet reserve → outbox insert.

## Constraints

- PostgreSQL is the source of truth.
- Wallet balance must never become negative.
- At-least-once message delivery is assumed.
- Domain code must not depend on NestJS or ORM types.
- Solution must remain small enough for a 15-hour coding challenge.
- Do **not** generate implementation code.

## Tasks

1. Identify the proposed aggregates and invariants.
2. Detect incorrect transactional boundaries.
3. Identify race conditions in quote acceptance.
4. Challenge whether Wallet and Conversion belong in the same aggregate.
5. Detect infrastructure leakage risks into the domain.
6. Evaluate outbox + consumer idempotency adequacy.
7. Return findings grouped by **Critical**, **Important**, and **Optional**.

## Output format

For each finding: title, why it matters, recommended action (design-level only).
End with “Approve to implement?” yes/no with conditions.

## Verification

Critical findings must be resolved in ADRs before Feature 1 coding starts.
