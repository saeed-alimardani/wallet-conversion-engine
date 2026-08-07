# Wallet Conversion Engine

A narrow, production-conscious NestJS modular monolith for digital-asset conversion:
quote → accept → reserve wallet funds → asynchronous execution → completed/failed.
Built with Domain-Driven Design, PostgreSQL invariants, a transactional outbox, and RabbitMQ.

> Features 0–6 complete. Architecture docs live in [`docs/`](./docs/); AI / prompt artefacts in
> [`ai/`](./ai/).

---

## Setup instructions

**Prerequisites:** Node.js ≥ 20, Docker + Docker Compose.

```bash
cp .env.example .env
docker compose up -d postgres rabbitmq
npm install
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed   # user-123 with 100 USDT + 0 BTC
```

Key env vars are documented in [`.env.example`](./.env.example) (`DATABASE_URL`, `RABBITMQ_URL`,
messaging toggles, `FAKE_EXCHANGE_MODE`).

---

## Run instructions

Local API (against Compose Postgres/RabbitMQ):

```bash
npm run start:dev
# listens on http://localhost:3000
curl http://localhost:3000/health
```

Full stack including the app container:

```bash
docker compose up --build --wait
npm run smoke:compose
```

Compose waits for PostgreSQL and RabbitMQ, applies all production migrations, seeds
`user-123`, and only then starts the API. The app is considered ready when `/health` succeeds.
Host ports can be overridden with `POSTGRES_PORT`, `RABBITMQ_PORT`,
`RABBITMQ_MANAGEMENT_PORT`, and `APP_PORT`.

Fake exchange default outcome is controlled by `FAKE_EXCHANGE_MODE=SUCCESS|FAILURE|UNKNOWN`
(also forwarded into the Compose `app` service). Messaging loops can be toggled with
`MESSAGING_ENABLED`, `OUTBOX_PUBLISHER_ENABLED`, and `EXECUTION_CONSUMER_ENABLED`.

---

## Test instructions

Start the required infrastructure, then run the repository's single verification command:

```bash
docker compose up -d postgres rabbitmq
npm run check
```

`npm run check` performs a non-mutating format check, zero-warning lint, production build,
120 domain/unit/property tests, and 72 serial integration/e2e tests. `test/setup-e2e.ts` keeps
RabbitMQ available but disables background publisher, consumer, and cleanup loops; tests drive
publish/process explicitly for deterministic assertions.

---

## API examples

```bash
# Create quote
curl -X POST http://localhost:3000/quotes \
  -H 'Content-Type: application/json' \
  -d '{"userId":"user-123","sourceAsset":"USDT","targetAsset":"BTC","sourceAmount":"100"}'

# Accept (Idempotency-Key required)
curl -X POST http://localhost:3000/quotes/<quoteId>/accept \
  -H 'Idempotency-Key: 4a985cf8-4f46-49b4-a916-3744073b3794'

# Query conversion
curl http://localhost:3000/conversions/<conversionId>

# Prometheus scrape
curl http://localhost:3000/metrics
```

Amounts are decimal **strings** at the API boundary (never JSON numbers).

---

## Architecture summary

Three bounded contexts in one process, one PostgreSQL database:

| Module       | Responsibility                                               |
| ------------ | ------------------------------------------------------------ |
| `pricing`    | Quotes, TTL, deterministic fake rates                        |
| `wallet`     | Balance / reserve / release / settle (conditional SQL)       |
| `conversion` | Accept orchestration, outbox, RabbitMQ worker, fake exchange |
| `shared`     | Money, Asset, Prisma, logging, metrics                       |

Accept is one ACID transaction: idempotency claim → quote accept → conversion
`CREATED`→`FUNDS_RESERVED` → wallet reserve → outbox insert. A batched publisher emits
`ConversionExecutionRequested` through a RabbitMQ confirm channel; the consumer settles or
releases idempotently via `processed_messages(event_id)`, with bounded retries and dead-lettering
for poison messages.

Diagrams and deeper design: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md),
[`docs/DOMAIN_MODEL.md`](./docs/DOMAIN_MODEL.md), [`docs/DECISIONS.md`](./docs/DECISIONS.md),
[`docs/FAILURE_SCENARIOS.md`](./docs/FAILURE_SCENARIOS.md),
[`docs/END_TO_END_FLOW.md`](./docs/END_TO_END_FLOW.md) (worked example walkthrough), and
[`docs/INTERVIEW_ANSWERS.md`](./docs/INTERVIEW_ANSWERS.md).

---

## Main trade-offs

1. **Modular monolith over microservices** — keeps accept+reserve+outbox in one local TX.
2. **Conditional SQL UPDATE over `SELECT FOR UPDATE`** — encodes the business rule in the
   predicate; losers fail fast under contention (scale-up path documented in ADR-004).
3. **No wallet `version` column** — predicate UPDATE is sufficient for this challenge.
4. **Reservation folded into `WalletAccount.reserved`** — avoids an anemic Reservation aggregate.
5. **UNKNOWN → REQUIRES_RECONCILIATION** holds funds; same `eventId` redelivery is a no-op after
   processed marker (safe for at-least-once; ops/venue query for real exchanges).
6. **Prometheus without high-cardinality identity labels** — operable metrics over perfect
   per-user cardinality.

---

## Known limitations

- Fake exchange only; no real venue status API (client order id correlation is modelled).
- `REQUIRES_RECONCILIATION` has no admin resolution HTTP API — state is modelled for ops follow-up.
- Outbox poller has residual duplicate-publish risk if crash occurs after broker accept and before
  `publishedAt` — mitigated by consumer idempotency.
- Under extreme same-wallet contention, conditional UPDATE losers fail rather than wait on a lock.
- No authentication/KYC (out of scope); do not expose publicly without an API gateway/auth layer.
- Wallet funding via seed/test helpers only — no public credit API in production mode.
- Idempotency cleanup is bounded and scheduled in-process; a production deployment should run
  retention as a separately monitored operational job.
- OpenTelemetry and Kubernetes manifests intentionally skipped.

---

## Time spent

Approximately **16–18 hours** wall-clock across planning, implementation Features 0–6,
documentation, AI artefacts, audit remediation, and test hardening. This is the candidate's
confirmed actual time, not an estimate inferred from Git history.

---

## AI tools used

**Cursor Agent with Grok 4.5** was used for the initial implementation; **Cursor Agent with
GPT-5.6 Sol** was used for the adversarial compliance audit, remediation, and final verification.
Evidence: [`ai/AI_USAGE.md`](./ai/AI_USAGE.md),
[`ai/PROMPT_ARCHITECTURE.md`](./ai/PROMPT_ARCHITECTURE.md), prompts `01`–`05`, and selected outputs.

AI was constrained not to redesign aggregates or introduce CQRS/Kafka/Redis locking. Human review
gates after each feature.

---

## Assumptions

1. Seed user `user-123` (100 USDT) is sufficient for local demos; tests create isolated users.
2. Supported pairs for the fake pricing provider include USDT↔BTC (deterministic rates).
3. Single-region single-process deployment for publisher + consumer is acceptable for this scope.
4. At-least-once RabbitMQ delivery; consumers must be idempotent.
5. Completed idempotency records are retained for 24h by default and deleted in bounded batches;
   in-progress records are not deleted by the cleanup loop.
6. System clocks are roughly synchronized for quote TTL checks.
7. Decimal scales: USDT 6, BTC 8; quote conversion uses ROUND_DOWN to target scale.
