# Prompt 04 — Test Design (Risk-Based)

**Role:** QA architect for a financial NestJS service.

## Context

Domain unit tests run with Jest (`npm test`) without Postgres.
Integration/e2e (`npm run test:e2e`) use Docker Compose Postgres + RabbitMQ.
E2E setup disables background publisher/consumer loops by default; tests may opt into messaging
and drive `publishBatch` / `ProcessConversionExecutionUseCase.execute` explicitly.
Fake exchange modes: SUCCESS | FAILURE | UNKNOWN; memoized by eventId.

## Constraints

- Prefer risk-based tests over controller-only smoke.
- Cover domain invariants, transaction boundaries, duplicate delivery, concurrent requests.
- No flaky sleeps as the primary synchronization — assert DB state.
- Do not invent APIs that do not exist.
- Money assertions use decimal strings / numeric equality that respects scale.

## Tasks

1. Produce a test matrix mapped to: Domain unit | Integration | Concurrency.
2. Cover at minimum the challenge §12 list (expired quote, duplicate accept, insufficient,
   reserve/release, invalid transitions, duplicate execution, atomic accept, outbox,
   idempotency replay, concurrent wallet, consumer idempotency, failed release).
3. Add edge cases: INVALID ids, IDEMPOTENCY_IN_PROGRESS, same-quote race, concurrent duplicate
   execution delivery, UNKNOWN holds reservation, metrics label cardinality.
4. For each row: file suggestion, assertion focus, infra needed.
5. Call out tests that are intentionally out of scope (e.g. real broker partition chaos).

## Output format

Markdown table + prioritized P0/P1/P2 list. No production code — test sketches allowed.

## Verification

P0 items must be implemented before submission; human confirms 80+80 concurrency proof exists.
