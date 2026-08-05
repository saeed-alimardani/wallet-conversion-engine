import { Asset } from '../../shared/domain/asset';
import { Money } from '../../shared/domain/money';
import { UserId } from '../../shared/domain/user-id';

export class InsufficientAvailableBalanceError extends Error {
  constructor(userId: UserId, asset: Asset, requested: Money, available: Money) {
    super(
      `Insufficient available balance for user ${userId.toString()} in ${asset.code}: ` +
        `requested ${requested.toString()}, available ${available.toString()}`,
    );
    this.name = 'InsufficientAvailableBalanceError';
  }
}

export class WalletInvariantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletInvariantViolationError';
  }
}

export interface WalletAccountSnapshot {
  id: string;
  userId: UserId;
  asset: Asset;
  balance: Money;
  available: Money;
  reserved: Money;
}

/**
 * `WalletAccount` is the aggregate root for a single (userId, asset) balance — e.g. one
 * row for "user-123's USDT" and a separate row for "user-123's BTC". A conversion touches
 * two WalletAccounts (source + target), coordinated by the application layer, never by
 * putting both inside one aggregate (see docs/DECISIONS.md: Wallet vs Conversion boundary).
 *
 * Consistency boundary, enforced on every mutation:
 *   available + reserved === balance
 * `available` and `reserved` can never be negative — this holds *structurally* because
 * `Money` itself refuses to represent a negative amount, so `assertInvariant` only needs
 * to check the equation, not separate non-negativity checks. This is the domain-level half
 * of invariant enforcement; `PrismaWalletRepository.reserve()` additionally enforces
 * non-negative-available at the database level with one conditional UPDATE, because two
 * in-process aggregate instances loaded concurrently could otherwise both pass this
 * in-memory check before either write lands (see spec §8 concurrency requirement).
 */
export class WalletAccount {
  private constructor(
    public readonly id: string,
    public readonly userId: UserId,
    public readonly asset: Asset,
    private balanceAmount: Money,
    private availableAmount: Money,
    private reservedAmount: Money,
  ) {
    this.assertInvariant();
  }

  static open(id: string, userId: UserId, asset: Asset, initialBalance: Money): WalletAccount {
    if (!initialBalance.asset.equals(asset)) {
      throw new WalletInvariantViolationError(
        `Initial balance asset ${initialBalance.asset.code} does not match wallet asset ${asset.code}`,
      );
    }
    return new WalletAccount(id, userId, asset, initialBalance, initialBalance, Money.zero(asset));
  }

  static reconstitute(snapshot: WalletAccountSnapshot): WalletAccount {
    return new WalletAccount(
      snapshot.id,
      snapshot.userId,
      snapshot.asset,
      snapshot.balance,
      snapshot.available,
      snapshot.reserved,
    );
  }

  get balance(): Money {
    return this.balanceAmount;
  }

  get available(): Money {
    return this.availableAmount;
  }

  get reserved(): Money {
    return this.reservedAmount;
  }

  private assertInvariant(): void {
    if (
      !this.balanceAmount.asset.equals(this.asset) ||
      !this.availableAmount.asset.equals(this.asset) ||
      !this.reservedAmount.asset.equals(this.asset)
    ) {
      throw new WalletInvariantViolationError(
        'WalletAccount amounts must all share the wallet asset',
      );
    }
    const recomposed = this.availableAmount.add(this.reservedAmount);
    if (!recomposed.equals(this.balanceAmount)) {
      throw new WalletInvariantViolationError(
        `Wallet invariant violated: available (${this.availableAmount.toString()}) + ` +
          `reserved (${this.reservedAmount.toString()}) != balance (${this.balanceAmount.toString()})`,
      );
    }
  }

  private assertSameAsset(amount: Money, operation: string): void {
    if (!amount.asset.equals(this.asset)) {
      throw new WalletInvariantViolationError(
        `Cannot ${operation} ${amount.asset.code} on a ${this.asset.code} wallet`,
      );
    }
  }

  /** Moves `amount` from available to reserved. Throws if available balance is insufficient. */
  reserve(amount: Money): void {
    this.assertSameAsset(amount, 'reserve');
    if (!this.availableAmount.isGreaterThanOrEqual(amount)) {
      throw new InsufficientAvailableBalanceError(
        this.userId,
        this.asset,
        amount,
        this.availableAmount,
      );
    }
    this.availableAmount = this.availableAmount.subtract(amount);
    this.reservedAmount = this.reservedAmount.add(amount);
    this.assertInvariant();
  }

  /** Moves `amount` from reserved back to available — e.g. a failed conversion releasing its hold. */
  release(amount: Money): void {
    this.assertSameAsset(amount, 'release');
    if (!this.reservedAmount.isGreaterThanOrEqual(amount)) {
      throw new WalletInvariantViolationError(
        `Cannot release ${amount.toString()}: only ${this.reservedAmount.toString()} is reserved`,
      );
    }
    this.reservedAmount = this.reservedAmount.subtract(amount);
    this.availableAmount = this.availableAmount.add(amount);
    this.assertInvariant();
  }

  /**
   * Permanently removes `amount` from reserved *and* from the total balance — the funds
   * have actually left the wallet (a successful conversion settling its source asset).
   * Does not touch `available` (it was already decremented when the reservation was made).
   */
  commitReservation(amount: Money): void {
    this.assertSameAsset(amount, 'commit a reservation for');
    if (!this.reservedAmount.isGreaterThanOrEqual(amount)) {
      throw new WalletInvariantViolationError(
        `Cannot commit ${amount.toString()}: only ${this.reservedAmount.toString()} is reserved`,
      );
    }
    this.reservedAmount = this.reservedAmount.subtract(amount);
    this.balanceAmount = this.balanceAmount.subtract(amount);
    this.assertInvariant();
  }

  /** Increases balance and available — a successful conversion crediting its target asset. */
  credit(amount: Money): void {
    this.assertSameAsset(amount, 'credit');
    this.balanceAmount = this.balanceAmount.add(amount);
    this.availableAmount = this.availableAmount.add(amount);
    this.assertInvariant();
  }
}
