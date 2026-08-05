# Selected Output 02 — Concurrency / Failure Matrix (from Prompt 03)

> Highest-value review output; drove ADR-001/002/004 and the concurrency test list.

## Matrix (abbreviated)

| Scenario | Risk without protection | Mitigation | Residual |
|----------|-------------------------|------------|----------|
| 80+80 vs 100 concurrent reserve | Negative available / double spend | Conditional `UPDATE … available >=` | Losers fail fast under contention |
| Duplicate HTTP same key | Double conversion / double reserve | Idempotency unique + stored response replay | In-progress concurrent loser may see 409 IN_PROGRESS briefly |
| Concurrent same key | Twin inserts | `ON CONFLICT DO NOTHING` then read winner; do not throw unique errors inside TX | Requires careful TX abort rules |
| Quote expires mid-accept | Accept stale price | `Quote.accept(now)` + TX rollback | Clock skew between instances |
| Outbox publish fail after commit | Stuck FUNDS_RESERVED | Retry unpublished rows; metric | Operator must watch `outbox_pending_count` |
| Publish OK, mark fails | Duplicate broker messages | Consumer `processed_messages` + exchange memo by eventId | Extra work on redelivery |
| Consumer processes twice | Double settle/credit | Unique event_id claim before wallet mutation | — |
| Exchange OK, crash before DB | Lost settlement | Redelivery + memoized exchange result | Real venue needs status query API |
| Settle OK, ack fails | Redelivery | Idempotent handler | — |
| Exchange UNKNOWN | Ambiguous funds | REQUIRES_RECONCILIATION; hold reservation; do not blind re-execute | Needs ops / venue query |
| Conflicting result after COMPLETED | Silent overwrite | `ConflictingExecutionResultError` + log | Manual investigation |

## Top tests required (P0)

1. Domain: reserve insufficient; reserve→release restores; invalid conversion transitions; conflicting terminal result.
2. Integration: atomic accept creates outbox + reserve; idempotent replay does not double-reserve.
3. Concurrency: two 80 USDT accepts vs 100 → statuses `{201,409}`, available=20, reserved=80.
4. Consumer: duplicate `execute(samePayload)` → single settle; balances unchanged on second call.
5. Failure: exchange FAILURE restores available; UNKNOWN leaves reserved unchanged.

## Critical design calls accepted

- Prefer predicate UPDATE over default `SELECT FOR UPDATE` (ADR-004).
- Treat UNKNOWN redelivery of the **same** eventId as no-op after processed marker (avoid duplicate venue orders).
- Business accept failures must roll back idempotency claims (abort TX), not leave completed error responses that poison keys.
