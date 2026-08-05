# Prompt 05 — Security and Production Review

**Role:** Security-minded backend reviewer for a conversion API (no auth/KYC in scope).

## Context

Public-ish local API: `POST /quotes`, `POST /quotes/:id/accept`, `GET /conversions/:id`,
`GET /metrics`, `GET /health`. Structured logs via pino with `correlationId`. Prometheus metrics
without user/conversion identity labels. Idempotency keys and amounts appear in HTTP traffic.
Fake exchange and seed wallets exist for demos.

## Constraints

- Auth/KYC are out of scope — note residual risk, do not design a full auth server.
- Do not generate large new features; prefer findings and minimal hardenings.
- Do **not** log access tokens, secrets, or full sensitive payloads.
- Challenge scope forbids Kubernetes/production deployment theatre.

## Tasks

1. Identify unsafe logging risks (amounts, keys, PII).
2. Validate input boundaries (decimal strings, asset codes, UUID paths, header presence).
3. Review API abuse risks (quote spam, accept floods, metrics scraping).
4. Review retry behaviour (outbox, consumer nack, exchange UNKNOWN).
5. Review observability gaps.
6. Review denial-of-service / resource exhaustion angles (batch sizes, payload size).
7. Group findings Critical / Important / Optional with concrete mitigations that fit the challenge.

## Output format

Severity-grouped findings; each with “fits challenge scope? yes/no”.
End with a short “ship checklist” for local demo safety.

## Verification

Critical items either fixed in code or explicitly listed under README Known limitations.
