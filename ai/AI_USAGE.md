# AI Usage

## Models and tools used

| Tool | Role |
|------|------|
| Cursor Agent (Grok 4.5 / Cursor Grok family) | Primary implementer under a frozen architecture plan; feature-gated delivery |
| Cursor IDE | Editing, lint/test feedback loop |
| Optional second-pass review prompts | Concurrency / security critique (prompts 03 and 05) |

AI was used as an assistant inside a human-owned process: the architecture document was frozen
first; AI was not allowed to redesign aggregates, transaction strategy, or persistence.

## Activities that used AI

1. Extracting and cross-checking challenge requirements against the delivery plan.
2. Scaffolding NestJS modules, Prisma schema, Docker Compose, and shared `Money`/`Asset` VOs.
3. Implementing Features 0–5 (wallet, quotes, accept TX, outbox/RabbitMQ, query + metrics).
4. Drafting Feature 6 documentation (`docs/`, `ai/`, README sections).
5. Generating and extending unit, integration, and concurrency tests.
6. Debugging (e.g. idempotency claim aborting the TX on unique violation → `ON CONFLICT DO NOTHING`).

## Suggestions accepted

- Modular monolith with `pricing` / `wallet` / `conversion` / `shared`.
- Conditional SQL `UPDATE … WHERE available >= :amount` without a version column.
- Transactional outbox + `processed_messages(event_id)` consumer idempotency.
- Folding Reservation into `WalletAccount.reserved` with conversion correlation.
- Stripe-style idempotency scope `POST:/quotes/:quoteId/accept`.
- Treating `REQUIRES_RECONCILIATION` as hold-reservation + ops follow-up for UNKNOWN.
- Feature-by-feature review gates with “list files → implement → stop”.

## Suggestions rejected

- Microservices / Kafka / Redis distributed locks / CQRS / event sourcing / sagas.
- Optimistic `version` column on wallets as the primary concurrency control.
- Separate Reservation aggregate with its own repository lifecycle.
- Holding `SELECT … FOR UPDATE` across broad application logic for the default path.
- High-cardinality Prometheus labels (`userId`, `conversionId`).
- Placeholder repositories, TODO stubs, or “fake” in-memory production paths.
- Silent architecture changes when implementation friction appeared — conflicts were escalated.

## Errors and hallucinations detected

| Issue | How caught | Resolution |
|-------|------------|------------|
| Throwing on idempotency unique violation aborted the Postgres TX (`25P02`) | Integration test + runtime error | Switch to `INSERT … ON CONFLICT DO NOTHING`, then read winner |
| Assumed `EXPIRED` must be persisted as a row status | Domain review | Keep `EXPIRED` derived from clock vs `expiresAt` when not accepted |
| Over-eager recovery that would auto-settle UNKNOWN on redelivery | Concurrency review | Record `processed_messages` for UNKNOWN; ops/manual resolve; memoize exchange by `eventId` |
| Express types missing after HTTP metrics interceptor | `npm run build` | Add `@types/express` |
| Invented endpoints / env vars not in the plan | Spec + plan check | Remove or align to `.env.example` |

## How generated code was verified

1. TypeScript build (`npm run build`).
2. ESLint (`npm run lint`).
3. Domain unit + property-based tests (`npm test`) — no infra.
4. Integration/e2e against Compose Postgres/RabbitMQ (`npm run test:e2e`).
5. Manual curl smoke for quote → accept → get → metrics.
6. Concurrency assertions on wallet balances after parallel accepts.

## Where human judgement overrode AI

- Freezing the architecture plan before large-scale coding.
- Choosing conditional UPDATE over row locks for ADR-004 (simplicity + reviewability).
- Keeping Reservation folded into the wallet (interview-facing justification in `DOMAIN_MODEL.md`).
- Disabling messaging loops in e2e setup and driving publish/process explicitly for determinism.
- Stopping after each feature for review instead of “finish the whole challenge in one pass”.
- Rejecting creative expansions (auth, fees, admin APIs) as out of scope.

## Did AI improve speed, design quality, or coverage?

- **Speed:** Yes — scaffolding, boilerplate Nest wiring, and first-draft tests were much faster.
- **Design quality:** Improved when used for critique (prompts 02/03); degraded when prompts were
  vague. The frozen plan + anti-hallucination rules were essential.
- **Test coverage:** Yes — AI helped expand race/edge matrices; humans required proofs
  (80+80 vs 100, duplicate delivery, expired accept rollback) rather than controller-only smoke.

**Net:** AI was effective as a constrained pair-programmer and reviewer, not as an architect of
record. The highest-value prompts were concurrency review and test-gap analysis.
