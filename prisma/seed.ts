/**
 * Local/dev seed helper. There is no public wallet-creation endpoint in this challenge's
 * scope (spec API surface is quotes/accept/conversions only), so wallets are funded here
 * instead. Uses the real `WalletAccount.open` domain constructor (not a bare Prisma
 * insert) so the seeded rows are guaranteed to satisfy the same invariant the rest of the
 * app relies on.
 *
 * Run with: npm run prisma:seed
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { WalletAccount } from '../src/modules/wallet/domain/wallet-account';
import { UserId } from '../src/modules/shared/domain/user-id';
import { Money } from '../src/modules/shared/domain/money';
import { Asset, USDT, BTC } from '../src/modules/shared/domain/asset';

const prisma = new PrismaClient();

async function upsertWallet(userId: string, asset: Asset, initialBalance: string): Promise<void> {
  const wallet = WalletAccount.open(randomUUID(), UserId.of(userId), asset, Money.of(initialBalance, asset));
  await prisma.walletAccount.upsert({
    where: { userId_asset: { userId, asset: asset.code } },
    update: {},
    create: {
      id: wallet.id,
      userId: wallet.userId.toString(),
      asset: wallet.asset.code,
      balance: wallet.balance.toString(),
      available: wallet.available.toString(),
      reserved: wallet.reserved.toString(),
    },
  });
  // eslint-disable-next-line no-console
  console.log(`Seeded wallet: user=${userId} asset=${asset.code} balance=${initialBalance}`);
}

async function main(): Promise<void> {
  // Matches the spec's worked example (100 USDT -> BTC) so the API can be exercised
  // out of the box once quotes/accept exist.
  await upsertWallet('user-123', USDT, '100');
  await upsertWallet('user-123', BTC, '0');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
