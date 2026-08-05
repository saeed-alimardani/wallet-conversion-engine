import fc from 'fast-check';
import Decimal from 'decimal.js';
import { randomUUID } from 'crypto';
import {
  InsufficientAvailableBalanceError,
  WalletAccount,
  WalletInvariantViolationError,
} from './wallet-account';
import { Money } from '../../shared/domain/money';
import { Asset, USDT, BTC } from '../../shared/domain/asset';
import { UserId } from '../../shared/domain/user-id';

function openWallet(balance: string, asset: Asset = USDT): WalletAccount {
  return WalletAccount.open(randomUUID(), UserId.of('user-123'), asset, Money.of(balance, asset));
}

/** Amounts with at most `asset.scale` decimal places, by construction. */
function arbitraryAmount(asset: Asset, maxMajorUnits = 1_000): fc.Arbitrary<Decimal> {
  const scaleFactor = new Decimal(10).pow(asset.scale);
  return fc
    .bigInt({ min: 0n, max: BigInt(maxMajorUnits) * 10n ** BigInt(asset.scale) })
    .map((minorUnits) => new Decimal(minorUnits.toString()).dividedBy(scaleFactor));
}

describe('WalletAccount', () => {
  describe('open', () => {
    it('starts with the full balance available and nothing reserved', () => {
      const wallet = openWallet('100');
      expect(wallet.balance.toString()).toBe('100.000000');
      expect(wallet.available.toString()).toBe('100.000000');
      expect(wallet.reserved.toString()).toBe('0.000000');
    });

    it('rejects an initial balance of a different asset', () => {
      expect(() =>
        WalletAccount.open(randomUUID(), UserId.of('user-123'), USDT, Money.of('1', BTC)),
      ).toThrow(WalletInvariantViolationError);
    });
  });

  describe('reserve', () => {
    it('moves funds from available to reserved', () => {
      const wallet = openWallet('100');
      wallet.reserve(Money.of('80', USDT));
      expect(wallet.available.toString()).toBe('20.000000');
      expect(wallet.reserved.toString()).toBe('80.000000');
      expect(wallet.balance.toString()).toBe('100.000000'); // reservation never changes total balance
    });

    it('rejects reservation when available balance is insufficient (spec §4.1.4)', () => {
      const wallet = openWallet('50');
      expect(() => wallet.reserve(Money.of('80', USDT))).toThrow(InsufficientAvailableBalanceError);
      // A failed reservation attempt must not mutate the wallet at all.
      expect(wallet.available.toString()).toBe('50.000000');
      expect(wallet.reserved.toString()).toBe('0.000000');
    });

    it('rejects reserving a different asset than the wallet holds', () => {
      const wallet = openWallet('100', USDT);
      expect(() => wallet.reserve(Money.of('1', BTC))).toThrow(WalletInvariantViolationError);
    });

    it('allows reserving exactly the full available balance (boundary)', () => {
      const wallet = openWallet('100');
      wallet.reserve(Money.of('100', USDT));
      expect(wallet.available.toString()).toBe('0.000000');
      expect(wallet.reserved.toString()).toBe('100.000000');
    });
  });

  describe('release', () => {
    it('moves funds back from reserved to available (spec §4.1.8: failed conversion releases reservation)', () => {
      const wallet = openWallet('100');
      wallet.reserve(Money.of('80', USDT));
      wallet.release(Money.of('80', USDT));
      expect(wallet.available.toString()).toBe('100.000000');
      expect(wallet.reserved.toString()).toBe('0.000000');
    });

    it('rejects releasing more than is currently reserved', () => {
      const wallet = openWallet('100');
      wallet.reserve(Money.of('30', USDT));
      expect(() => wallet.release(Money.of('50', USDT))).toThrow(WalletInvariantViolationError);
    });
  });

  describe('reserve-then-release identity (property-based)', () => {
    it('restores the exact original available/reserved/balance for arbitrary amounts', () => {
      fc.assert(
        fc.property(
          arbitraryAmount(USDT, 1_000_000),
          arbitraryAmount(USDT, 1_000_000),
          (initial, reserveAmount) => {
            fc.pre(reserveAmount.lessThanOrEqualTo(initial)); // only exercise valid reservations
            const wallet = openWallet(initial.toString());
            const before = {
              available: wallet.available,
              reserved: wallet.reserved,
              balance: wallet.balance,
            };

            wallet.reserve(Money.of(reserveAmount, USDT));
            wallet.release(Money.of(reserveAmount, USDT));

            expect(wallet.available.equals(before.available)).toBe(true);
            expect(wallet.reserved.equals(before.reserved)).toBe(true);
            expect(wallet.balance.equals(before.balance)).toBe(true);
          },
        ),
      );
    });
  });

  describe('commitReservation (spec: completed conversion settles the reservation)', () => {
    it('removes the amount from both reserved and balance, leaving available untouched', () => {
      const wallet = openWallet('100');
      wallet.reserve(Money.of('80', USDT));
      wallet.commitReservation(Money.of('80', USDT));
      expect(wallet.reserved.toString()).toBe('0.000000');
      expect(wallet.balance.toString()).toBe('20.000000');
      expect(wallet.available.toString()).toBe('20.000000');
    });

    it('rejects committing more than is currently reserved', () => {
      const wallet = openWallet('100');
      wallet.reserve(Money.of('30', USDT));
      expect(() => wallet.commitReservation(Money.of('50', USDT))).toThrow(
        WalletInvariantViolationError,
      );
    });
  });

  describe('credit (target-asset settlement on a successful conversion)', () => {
    it('increases both balance and available', () => {
      const wallet = openWallet('0', BTC);
      wallet.credit(Money.of('0.00161', BTC));
      expect(wallet.balance.toString()).toBe('0.00161000');
      expect(wallet.available.toString()).toBe('0.00161000');
      expect(wallet.reserved.toString()).toBe('0.00000000');
    });

    it('rejects crediting a different asset than the wallet holds', () => {
      const wallet = openWallet('0', BTC);
      expect(() => wallet.credit(Money.of('1', USDT))).toThrow(WalletInvariantViolationError);
    });
  });

  describe('reconstitute', () => {
    it('rebuilds a wallet from a persisted snapshot and re-validates the invariant', () => {
      const id = randomUUID();
      const userId = UserId.of('user-123');
      const wallet = WalletAccount.reconstitute({
        id,
        userId,
        asset: USDT,
        balance: Money.of('100', USDT),
        available: Money.of('20', USDT),
        reserved: Money.of('80', USDT),
      });
      expect(wallet.id).toBe(id);
      expect(wallet.available.toString()).toBe('20.000000');
      expect(wallet.reserved.toString()).toBe('80.000000');
    });

    it('throws when the persisted snapshot violates available + reserved = balance', () => {
      expect(() =>
        WalletAccount.reconstitute({
          id: randomUUID(),
          userId: UserId.of('user-123'),
          asset: USDT,
          balance: Money.of('100', USDT),
          available: Money.of('20', USDT),
          reserved: Money.of('50', USDT), // 20 + 50 != 100
        }),
      ).toThrow(WalletInvariantViolationError);
    });
  });
});
