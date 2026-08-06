import { randomUUID } from 'crypto';
import { PrismaService } from '../src/modules/shared/infrastructure/prisma/prisma.service';
import {
  PrismaWalletRepository,
  WalletNotFoundError,
} from '../src/modules/wallet/infrastructure/prisma-wallet.repository';
import { WalletAccount } from '../src/modules/wallet/domain/wallet-account';
import { Money } from '../src/modules/shared/domain/money';
import { USDT, BTC } from '../src/modules/shared/domain/asset';
import { UserId } from '../src/modules/shared/domain/user-id';

/**
 * Integration tests against a real Postgres (requires `docker compose up -d postgres`).
 * Covers the persistence-layer half of spec §8 (concurrency) and §4.1 (wallet invariants)
 * that pure domain unit tests cannot: the actual conditional UPDATE racing under load.
 */
describe('PrismaWalletRepository (integration)', () => {
  const prisma = new PrismaService();
  const repository = new PrismaWalletRepository(prisma);

  const testUserIdPrefix = 'test-wallet-repo-';

  function freshUserId(): UserId {
    return UserId.of(`${testUserIdPrefix}${randomUUID()}`);
  }

  async function seedWallet(userId: UserId, balance: string): Promise<void> {
    const wallet = WalletAccount.open(randomUUID(), userId, USDT, Money.of(balance, USDT));
    await repository.create(wallet);
  }

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.walletAccount.deleteMany({ where: { userId: { startsWith: testUserIdPrefix } } });
    await prisma.$disconnect();
  });

  it('creates a wallet and finds it back by (userId, asset)', async () => {
    const userId = freshUserId();
    await seedWallet(userId, '100');

    const found = await repository.findByUserAndAsset(userId, USDT);
    expect(found).not.toBeNull();
    expect(found?.balance.toString()).toBe('100.000000');
    expect(found?.available.toString()).toBe('100.000000');
  });

  it('returns null for a wallet that does not exist', async () => {
    const found = await repository.findByUserAndAsset(freshUserId(), BTC);
    expect(found).toBeNull();
  });

  it('createIfMissing() is safe under concurrent target-wallet creation', async () => {
    const userId = freshUserId();
    await Promise.all(
      Array.from({ length: 20 }, () =>
        repository.createIfMissing(WalletAccount.open(randomUUID(), userId, BTC, Money.zero(BTC))),
      ),
    );

    expect(
      await prisma.walletAccount.count({
        where: { userId: userId.toString(), asset: BTC.code },
      }),
    ).toBe(1);
    const wallet = await repository.findByUserAndAsset(userId, BTC);
    expect(wallet?.balance.toString()).toBe('0.00000000');
  });

  it('reserve() atomically moves funds from available to reserved', async () => {
    const userId = freshUserId();
    await seedWallet(userId, '100');

    const result = await repository.reserve(userId, USDT, Money.of('80', USDT));
    expect(result.outcome).toBe('reserved');
    if (result.outcome === 'reserved') {
      expect(result.wallet.available.toString()).toBe('20.000000');
      expect(result.wallet.reserved.toString()).toBe('80.000000');
    }
  });

  it('reserve() reports insufficient-or-conflict without mutating the row when funds are too low', async () => {
    const userId = freshUserId();
    await seedWallet(userId, '50');

    const result = await repository.reserve(userId, USDT, Money.of('80', USDT));
    expect(result.outcome).toBe('insufficient-or-conflict');

    const wallet = await repository.findByUserAndAsset(userId, USDT);
    expect(wallet?.available.toString()).toBe('50.000000');
    expect(wallet?.reserved.toString()).toBe('0.000000');
  });

  it(
    'CONCURRENCY: exactly one of two simultaneous 80-unit reservations against a 100-unit ' +
      'wallet succeeds, and the wallet never goes negative (spec §8)',
    async () => {
      const userId = freshUserId();
      await seedWallet(userId, '100');

      const [resultA, resultB] = await Promise.all([
        repository.reserve(userId, USDT, Money.of('80', USDT)),
        repository.reserve(userId, USDT, Money.of('80', USDT)),
      ]);

      const outcomes = [resultA.outcome, resultB.outcome].sort();
      expect(outcomes).toEqual(['insufficient-or-conflict', 'reserved']);

      const finalWallet = await repository.findByUserAndAsset(userId, USDT);
      expect(finalWallet?.available.toString()).toBe('20.000000');
      expect(finalWallet?.reserved.toString()).toBe('80.000000');
      // The invariant balance = available + reserved is re-checked by WalletAccount's own
      // constructor when findByUserAndAsset reconstitutes it, so reaching this line at all
      // is itself proof the invariant held; the explicit checks above pin the exact values.
      expect(Number(finalWallet?.available.toDecimal())).toBeGreaterThanOrEqual(0);
    },
  );

  it('release() moves funds back from reserved to available', async () => {
    const userId = freshUserId();
    await seedWallet(userId, '100');
    await repository.reserve(userId, USDT, Money.of('80', USDT));

    const wallet = await repository.release(userId, USDT, Money.of('80', USDT));
    expect(wallet.available.toString()).toBe('100.000000');
    expect(wallet.reserved.toString()).toBe('0.000000');
  });

  it('commitReservation() removes funds from reserved and balance, leaving available untouched', async () => {
    const userId = freshUserId();
    await seedWallet(userId, '100');
    await repository.reserve(userId, USDT, Money.of('80', USDT));

    const wallet = await repository.commitReservation(userId, USDT, Money.of('80', USDT));
    expect(wallet.reserved.toString()).toBe('0.000000');
    expect(wallet.balance.toString()).toBe('20.000000');
    expect(wallet.available.toString()).toBe('20.000000');
  });

  it('credit() increases balance and available', async () => {
    const userId = freshUserId();
    await seedWallet(userId, '0');

    const wallet = await repository.credit(userId, USDT, Money.of('0.5', USDT));
    expect(wallet.balance.toString()).toBe('0.500000');
    expect(wallet.available.toString()).toBe('0.500000');
  });

  it('credit() throws WalletNotFoundError for a wallet that was never seeded', async () => {
    await expect(repository.credit(freshUserId(), BTC, Money.of('1', BTC))).rejects.toThrow(
      WalletNotFoundError,
    );
  });
});
