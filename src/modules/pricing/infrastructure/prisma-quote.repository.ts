import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/infrastructure/prisma/prisma.service';
import { PrismaDb } from '../../shared/infrastructure/prisma/prisma-client.types';
import { Asset } from '../../shared/domain/asset';
import { Money } from '../../shared/domain/money';
import { UserId } from '../../shared/domain/user-id';
import { ExchangeRate } from '../domain/exchange-rate';
import { Quote, QuoteStatus } from '../domain/quote';
import { QuoteId } from '../domain/quote-id';
import { QuoteRepository } from '../domain/ports/quote-repository.port';

@Injectable()
export class PrismaQuoteRepository implements QuoteRepository {
  private readonly db: PrismaDb;

  constructor(prisma: PrismaService) {
    this.db = prisma;
  }

  static forTransaction(tx: PrismaDb): PrismaQuoteRepository {
    return new PrismaQuoteRepository(tx as PrismaService);
  }

  async save(quote: Quote): Promise<void> {
    const data = {
      id: quote.id.toString(),
      userId: quote.userId.toString(),
      sourceAsset: quote.sourceAsset.code,
      targetAsset: quote.targetAsset.code,
      sourceAmount: quote.sourceAmount.toString(),
      targetAmount: quote.targetAmount.toString(),
      rate: quote.rate.toString(),
      status: quote.status,
      createdAt: quote.createdAt,
      expiresAt: quote.expiresAt,
      acceptedAt: quote.acceptedAt,
    };

    await this.db.quote.upsert({
      where: { id: data.id },
      create: data,
      update: {
        status: data.status,
        acceptedAt: data.acceptedAt,
      },
    });
  }

  async findById(id: QuoteId): Promise<Quote | null> {
    const row = await this.db.quote.findUnique({ where: { id: id.toString() } });
    if (!row) {
      return null;
    }
    return this.toDomain(row);
  }

  async saveAccepted(quote: Quote, now: Date): Promise<Quote | null> {
    if (quote.status !== 'ACCEPTED' || quote.acceptedAt === null) {
      throw new Error('saveAccepted requires a quote that has already been accept()ed in-memory');
    }

    const rows = await this.db.$queryRaw<
      Array<{
        id: string;
        userId: string;
        sourceAsset: string;
        targetAsset: string;
        sourceAmount: unknown;
        targetAmount: unknown;
        rate: unknown;
        status: string;
        createdAt: Date;
        expiresAt: Date;
        acceptedAt: Date | null;
      }>
    >`
      UPDATE quotes
      SET status = 'ACCEPTED',
          accepted_at = ${quote.acceptedAt}
      WHERE id = ${quote.id.toString()}
        AND status = 'ACTIVE'
        AND expires_at >= ${now}
      RETURNING
        id,
        user_id AS "userId",
        source_asset AS "sourceAsset",
        target_asset AS "targetAsset",
        source_amount AS "sourceAmount",
        target_amount AS "targetAmount",
        rate,
        status,
        created_at AS "createdAt",
        expires_at AS "expiresAt",
        accepted_at AS "acceptedAt"
    `;

    if (rows.length === 0) {
      return null;
    }
    return this.toDomain(rows[0]);
  }

  private toDomain(row: {
    id: string;
    userId: string;
    sourceAsset: string;
    targetAsset: string;
    sourceAmount: unknown;
    targetAmount: unknown;
    rate: unknown;
    status: string;
    createdAt: Date;
    expiresAt: Date;
    acceptedAt: Date | null;
  }): Quote {
    const sourceAsset = Asset.of(row.sourceAsset);
    const targetAsset = Asset.of(row.targetAsset);
    const status = row.status as QuoteStatus;
    if (status !== 'ACTIVE' && status !== 'ACCEPTED') {
      throw new Error(`Unexpected persisted quote status: ${row.status}`);
    }

    return Quote.reconstitute({
      id: QuoteId.of(row.id),
      userId: UserId.of(row.userId),
      sourceAmount: Money.of(String(row.sourceAmount), sourceAsset),
      targetAmount: Money.of(String(row.targetAmount), targetAsset),
      rate: ExchangeRate.of(sourceAsset, targetAsset, String(row.rate)),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      status,
      acceptedAt: row.acceptedAt,
    });
  }
}
