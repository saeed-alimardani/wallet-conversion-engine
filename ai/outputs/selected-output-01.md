# Selected Output 01 — Domain Discovery (from Prompt 01)

> Condensed accepted output used to freeze aggregates before Feature 1.

## Language

- **Quote** — priced offer with TTL; accept-once.
- **Conversion** — lifecycle of one accepted quote through execution.
- **WalletAccount** — per user+asset balances: `balance`, `available`, `reserved`.
- **Reservation** — held amount correlated 1:1 with a conversion; not a separate root.
- **Money / Asset / ExchangeRate** — exact decimal value objects.

## Aggregates (accepted)

| Aggregate | Boundary |
|-----------|----------|
| Quote | Expiry + single accept + `acceptedAt` |
| WalletAccount | Financial invariants for one user+asset |
| Conversion | State machine only |

**Wallet ≠ Conversion:** shared wallet across many conversions; coordinate in one DB TX on accept.

**Reservation folded into WalletAccount:** no independent lifecycle; correlation id = conversion id.

## Invariants (must enforce)

1. Expired quote cannot accept.
2. Quote accepts once.
3. Idempotency key cannot create multiple conversions.
4. Available never negative (domain + conditional SQL).
5. `available + reserved = balance`.
6. Execution event settles at most once.
7. Terminal conversion cannot rewind; conflicting results flagged.
8. Failed execution releases reservation.
9. No JS float money.

## Open questions resolved as safe-defaults

| Question | Default |
|----------|---------|
| Persist EXPIRED status? | Derive from clock; do not require a row rewrite |
| Reservation entity table? | No — reserved counter + conversion correlation |
| Version column on wallet? | No — predicate UPDATE |
| UNKNOWN automatic retry settle? | No — hold funds; ops/client-order query path |

## Explicitly deferred

Auth, fees, real exchange, multi-currency ledgers, admin reconciliation UI.
