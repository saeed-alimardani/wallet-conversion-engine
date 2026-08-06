import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/infrastructure/prisma/prisma.service';
import { PrismaDb } from '../../shared/infrastructure/prisma/prisma-client.types';
import { Asset } from '../../shared/domain/asset';
import { Money } from '../../shared/domain/money';
import { UserId } from '../../shared/domain/user-id';
import { WalletAccount, WalletInvariantViolationError } from '../domain/wallet-account';
import { ReservationOutcome, WalletRepository } from '../domain/ports/wallet-repository.port';

interface WalletAccountRow {
  id: string;
  userId: string;
  asset: string;
  balance: unknown;
  available: unknown;
  reserved: unknown;
}

export class WalletNotFoundError extends Error {
  constructor(userId: UserId, asset: Asset) {
    super(`No wallet found for user ${userId.toString()} in ${asset.code}`);
    this.name = 'WalletNotFoundError';
  }
}

@Injectable()
export class PrismaWalletRepository implements WalletRepository {
  private readonly db: PrismaDb;

  constructor(prisma: PrismaService) {
    this.db = prisma;
  }

  /** Bind this repository to a transaction client (Unit of Work). */
  static forTransaction(tx: PrismaDb): PrismaWalletRepository {
    return new PrismaWalletRepository(tx as PrismaService);
  }

  async findByUserAndAsset(userId: UserId, asset: Asset): Promise<WalletAccount | null> {
    const row = await this.db.walletAccount.findUnique({
      where: { userId_asset: { userId: userId.toString(), asset: asset.code } },
    });
    return row ? this.toDomain(row) : null;
  }

  async create(wallet: WalletAccount): Promise<void> {
    await this.db.walletAccount.create({
      data: {
        id: wallet.id,
        userId: wallet.userId.toString(),
        asset: wallet.asset.code,
        balance: wallet.balance.toString(),
        available: wallet.available.toString(),
        reserved: wallet.reserved.toString(),
      },
    });
  }

  async createIfMissing(wallet: WalletAccount): Promise<void> {
    if (!wallet.balance.isZero) {
      throw new WalletInvariantViolationError('createIfMissing requires a zero-balance wallet');
    }
    await this.db.$executeRaw`
      INSERT INTO wallet_accounts
        (id, user_id, asset, balance, available, reserved, created_at, updated_at)
      VALUES
        (
          ${wallet.id},
          ${wallet.userId.toString()},
          ${wallet.asset.code},
          0,
          0,
          0,
          NOW(),
          NOW()
        )
      ON CONFLICT (user_id, asset) DO NOTHING
    `;
  }

  async reserve(userId: UserId, asset: Asset, amount: Money): Promise<ReservationOutcome> {
    const rows = await this.db.$queryRaw<WalletAccountRow[]>`
      UPDATE wallet_accounts
      SET available = available - ${amount.toString()}::numeric,
          reserved  = reserved + ${amount.toString()}::numeric,
          updated_at = NOW()
      WHERE user_id = ${userId.toString()}
        AND asset = ${asset.code}
        AND available >= ${amount.toString()}::numeric
      RETURNING id, user_id AS "userId", asset, balance, available, reserved
    `;
    if (rows.length === 0) {
      return { outcome: 'insufficient-or-conflict' };
    }
    return { outcome: 'reserved', wallet: this.toDomain(rows[0]) };
  }

  async release(userId: UserId, asset: Asset, amount: Money): Promise<WalletAccount> {
    const rows = await this.db.$queryRaw<WalletAccountRow[]>`
      UPDATE wallet_accounts
      SET available = available + ${amount.toString()}::numeric,
          reserved  = reserved - ${amount.toString()}::numeric,
          updated_at = NOW()
      WHERE user_id = ${userId.toString()}
        AND asset = ${asset.code}
        AND reserved >= ${amount.toString()}::numeric
      RETURNING id, user_id AS "userId", asset, balance, available, reserved
    `;
    if (rows.length === 0) {
      throw new WalletInvariantViolationError(
        `Cannot release ${amount.toString()} for user ${userId.toString()}/${asset.code}: ` +
          'insufficient reserved balance (wallet missing or reservation already resolved)',
      );
    }
    return this.toDomain(rows[0]);
  }

  async commitReservation(userId: UserId, asset: Asset, amount: Money): Promise<WalletAccount> {
    const rows = await this.db.$queryRaw<WalletAccountRow[]>`
      UPDATE wallet_accounts
      SET reserved = reserved - ${amount.toString()}::numeric,
          balance  = balance - ${amount.toString()}::numeric,
          updated_at = NOW()
      WHERE user_id = ${userId.toString()}
        AND asset = ${asset.code}
        AND reserved >= ${amount.toString()}::numeric
      RETURNING id, user_id AS "userId", asset, balance, available, reserved
    `;
    if (rows.length === 0) {
      throw new WalletInvariantViolationError(
        `Cannot commit reservation of ${amount.toString()} for user ${userId.toString()}/${asset.code}: ` +
          'insufficient reserved balance (wallet missing or reservation already resolved)',
      );
    }
    return this.toDomain(rows[0]);
  }

  async credit(userId: UserId, asset: Asset, amount: Money): Promise<WalletAccount> {
    const rows = await this.db.$queryRaw<WalletAccountRow[]>`
      UPDATE wallet_accounts
      SET balance   = balance + ${amount.toString()}::numeric,
          available = available + ${amount.toString()}::numeric,
          updated_at = NOW()
      WHERE user_id = ${userId.toString()}
        AND asset = ${asset.code}
      RETURNING id, user_id AS "userId", asset, balance, available, reserved
    `;
    if (rows.length === 0) {
      throw new WalletNotFoundError(userId, asset);
    }
    return this.toDomain(rows[0]);
  }

  private toDomain(row: WalletAccountRow): WalletAccount {
    const asset = Asset.of(row.asset);
    return WalletAccount.reconstitute({
      id: row.id,
      userId: UserId.of(row.userId),
      asset,
      balance: Money.of(String(row.balance), asset),
      available: Money.of(String(row.available), asset),
      reserved: Money.of(String(row.reserved), asset),
    });
  }
}
