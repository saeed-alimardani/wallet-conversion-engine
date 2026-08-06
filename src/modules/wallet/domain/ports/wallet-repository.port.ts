import { Asset } from '../../../shared/domain/asset';
import { Money } from '../../../shared/domain/money';
import { UserId } from '../../../shared/domain/user-id';
import { WalletAccount } from '../wallet-account';

/**
 * Result of an atomic conditional reservation attempt at the persistence layer.
 * `insufficient-or-conflict` deliberately does not distinguish "genuinely insufficient
 * funds" from "a concurrent reservation consumed them first" — from the caller's
 * perspective both mean "the reservation did not happen; do not proceed" (spec §8).
 */
export type ReservationOutcome =
  { outcome: 'reserved'; wallet: WalletAccount } | { outcome: 'insufficient-or-conflict' };

export interface WalletRepository {
  findByUserAndAsset(userId: UserId, asset: Asset): Promise<WalletAccount | null>;

  /** Persists a brand-new wallet. Seeding only in this challenge's scope (no public create-wallet API, spec API surface). */
  create(wallet: WalletAccount): Promise<void>;

  /** Atomically creates a zero-balance settlement wallet, or leaves the existing wallet unchanged. */
  createIfMissing(wallet: WalletAccount): Promise<void>;

  /**
   * Atomically reserves `amount` using a single conditional
   * `UPDATE ... WHERE available >= amount` (see docs/DECISIONS.md) — the primary
   * concurrency-safety mechanism required by spec §8.
   */
  reserve(userId: UserId, asset: Asset, amount: Money): Promise<ReservationOutcome>;

  /** Moves `amount` from reserved back to available (a failed conversion releasing its hold). */
  release(userId: UserId, asset: Asset, amount: Money): Promise<WalletAccount>;

  /** Permanently removes `amount` from reserved and balance (a completed conversion settling its source asset). */
  commitReservation(userId: UserId, asset: Asset, amount: Money): Promise<WalletAccount>;

  /** Increases balance and available (a completed conversion crediting its target asset). */
  credit(userId: UserId, asset: Asset, amount: Money): Promise<WalletAccount>;
}
