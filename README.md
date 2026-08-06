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

Fake exchange default outcome is controlled by `FAKE_EXCHANGE_MODE=SUCCESS|FAILURE|UNKNOWN`.

---

## Test instructions

```bash
npm test          # domain unit + property-based tests (no infra)
npm run test:e2e  # integration/e2e (requires: docker compose up -d postgres rabbitmq)
```

`test/setup-e2e.ts` disables background outbox publisher / execution consumer loops by default
so suites stay deterministic; execution tests opt into messaging and drive publish/process
explicitly.

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

| Module | Responsibility |
|--------|----------------|
| `pricing` | Quotes, TTL, deterministic fake rates |
| `wallet` | Balance / reserve / release / settle (conditional SQL) |
| `conversion` | Accept orchestration, outbox, RabbitMQ worker, fake exchange |
| `shared` | Money, Asset, Prisma, logging, metrics |

Accept is one ACID transaction: idempotency claim → quote accept → conversion
`CREATED`→`FUNDS_RESERVED` → wallet reserve → outbox insert. A batched publisher emits
`ConversionExecutionRequested` to RabbitMQ; the consumer settles or releases idempotently via
`processed_messages(event_id)`.

Diagrams and deeper design: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md),
[`docs/DOMAIN_MODEL.md`](./docs/DOMAIN_MODEL.md), [`docs/DECISIONS.md`](./docs/DECISIONS.md),
[`docs/FAILURE_SCENARIOS.md`](./docs/FAILURE_SCENARIOS.md).

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
- OpenTelemetry and Kubernetes manifests intentionally skipped.

---

## Time spent

Approximately **16–18 hours** wall-clock across planning, implementation Features 0–6,
documentation, AI artefacts, and test hardening (aligned with the challenge’s 15–18h guidance).

---

## AI tools used

Primary: **Cursor Agent** (Grok / Cursor Grok family) for implementation assistance, critique, and
test generation under a frozen architecture plan. Evidence: [`ai/AI_USAGE.md`](./ai/AI_USAGE.md),
[`ai/PROMPT_ARCHITECTURE.md`](./ai/PROMPT_ARCHITECTURE.md), prompts `01`–`05`, selected outputs.

AI was constrained not to redesign aggregates or introduce CQRS/Kafka/Redis locking. Human review
gates after each feature.

---

## Assumptions

1. Seed user `user-123` (100 USDT) is sufficient for local demos; tests create isolated users.
2. Supported pairs for the fake pricing provider include USDT↔BTC (deterministic rates).
3. Single-region single-process deployment for publisher + consumer is acceptable for this scope.
4. At-least-once RabbitMQ delivery; consumers must be idempotent.
5. Idempotency records are retained on the order of ~24h (operational policy; cleanup job not
   required for the challenge).
6. System clocks are roughly synchronized for quote TTL checks.
7. Decimal scales: USDT 6, BTC 8; quote conversion uses ROUND_DOWN to target scale.
