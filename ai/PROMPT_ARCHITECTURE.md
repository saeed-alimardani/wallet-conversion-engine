# Prompt Architecture

## Objective

Use AI as a constrained engineering assistant across a review-gated delivery of a NestJS
modular monolith — never as an unsupervised code generator. Prompts separate **exploration**,
**critique**, **implementation assistance**, **test design**, and **security/reliability review**
so each stage has a clear role, output shape, and verification gate.

## System context

- Challenge: Pooleno Senior Node.js Backend Challenge (wallet reservation + async conversion).
- Stack: NestJS, TypeScript strict, Prisma, PostgreSQL, RabbitMQ, decimal.js, Prometheus.
- Process: frozen architecture plan; feature-by-feature implementation with human review gates.
- Non-goals: microservices, CQRS, event sourcing, Redis locking, real exchange, K8s, OTel.

## Domain context (injected into prompts)

Short-lived quote (20s) → accept with idempotency → reserve wallet → transactional outbox →
RabbitMQ → fake exchange (SUCCESS/FAILURE/UNKNOWN) → settle or release. Invariants: non-negative
available, single quote accept, no double settle, no JS float money.

## Constraints (standing rules for every prompt)

1. PostgreSQL is the source of truth.
2. Domain code must not import NestJS, Prisma, HTTP, or amqplib.
3. Do not redesign aggregate boundaries or transaction strategy without explicit approval.
4. Prefer the smallest change that preserves the frozen architecture.
5. No placeholder / TODO / fake repository implementations.
6. Money as decimal strings at API/DB boundaries.
7. Assume at-least-once messaging.

## Expected output structure (by stage)

| Stage                    | Output                                                                    |
| ------------------------ | ------------------------------------------------------------------------- |
| Exploration (01)         | Ubiquitous language, aggregates, invariants, open questions — **no code** |
| Architecture review (02) | Findings: Critical / Important / Optional — **no code**                   |
| Concurrency review (03)  | Race matrix, failure modes, mitigations — **no code**                     |
| Implementation (ad-hoc)  | Patch-sized changes matching the plan; list files first                   |
| Test design (04)         | Risk-based test matrix mapped to files/commands                           |
| Security review (05)     | Logging/input/retry/DoS findings with severity                            |
| Compliance audit         | Requirement-by-requirement verdict with file/line evidence; no edits      |
| Remediation              | One approved defect class per stage; tests, commit, push, then stop       |

## Verification criteria

- Architecture plan remains the source of truth; silent redesign is a defect.
- The single documented gate, `npm run check`, must pass formatting, lint, production build,
  unit/property tests, and integration/e2e.
- Integration/e2e use Compose PostgreSQL and RabbitMQ with background loops disabled for
  deterministic orchestration.
- Concurrency proof: 80+80 vs 100 USDT → one success, one failure, never negative.
- Metrics have no high-cardinality identity labels.

## Iteration strategy

```
Domain Discovery (01)
        ↓
Architecture Review (02)
        ↓
Concurrency / Failure Review (03)
        ↓
Feature implementation (human-gated, plan-locked)
        ↓
Test Gap Analysis (04)
        ↓
Security / Production Review (05)
        ↓
Hostile challenge compliance audit
        ↓
Human-approved staged remediation
        ↓
Clean-room final verification
```

After each feature: explain → list files → implement → verify → **stop for human review**.
If AI proposes an architecture change, surface conflict + minimal patch proposal; wait for approval.

## Context boundaries

| In scope for a prompt                | Out of scope                        |
| ------------------------------------ | ----------------------------------- |
| Current feature + cited plan section | Rewriting unrelated modules         |
| Named files / failing tests          | “Make it production-ready globally” |
| Spec invariants                      | New tech (Kafka, Redis, CQRS)       |
| Concrete race scenarios              | Speculative multi-region design     |

Implementation prompts receive only the feature slice; review prompts receive design text, not
a dump of the whole repo unless needed for a specific finding.

## Use of examples

- Spec numeric example: `100 USDT × 0.0000161 → 0.00161 BTC`.
- Concurrency example: wallet 100, concurrent reserves 80 and 80.
- Strong review prompt pattern from the challenge (principal architect role, Critical/Important/Optional, no code).

## Anti-hallucination controls

1. **No code in exploration/review prompts** — reduces invented APIs.
2. **Cite the frozen plan / ADR** before changing behavior.
3. **Require file lists before edits** — deters drive-by refactors.
4. **Verify with compilers and tests** — never merge on narrative alone; `npm run check` is the
   repeatable final gate.
5. **Reject new abstractions** unless the plan already names them.
6. **Call out uncertainty** — prompts ask the model to mark assumptions vs facts.
7. **Human gate** after each feature — catches confident wrongness early.

## Separation of prompt types

| Type           | Role                                                    |
| -------------- | ------------------------------------------------------- |
| Exploration    | Discover language and aggregates; forbid implementation |
| Implementation | Narrow feature work under the plan                      |
| Review         | Adversarial critique of boundaries, races, security     |
| Validation     | Test matrix and verification commands                   |

The five submitted prompts (`prompts/01`–`05`) are the durable planned evidence chain.
`outputs/selected-output-01.md` and `selected-output-02.md` are explicitly condensed, curated
outputs—not raw transcripts. Day-to-day implementation and remediation prompts were shorter
feature slices that inherited the same constraints; accepted changes are independently evidenced
by tests and Git commits rather than by trusting the transcript.

## Provenance note

The files in `prompts/` are the final version-controlled prompt forms after iteration; they are
not claimed to be immutable raw chat exports. Their context was updated when verified
implementation facts changed (for example, publisher confirms and durable exchange outcomes).
The selected outputs preserve important accepted conclusions and explicitly annotate later human
corrections. This distinction avoids presenting reconstructed evidence as a verbatim transcript.
