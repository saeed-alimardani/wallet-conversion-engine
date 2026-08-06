import { randomUUID } from 'crypto';
import { PrismaService } from '../src/modules/shared/infrastructure/prisma/prisma.service';
import { PrismaIdempotencyRepository } from '../src/modules/conversion/infrastructure/prisma-idempotency.repository';

describe('Persistence hardening (integration)', () => {
  const prisma = new PrismaService();
  const idempotency = new PrismaIdempotencyRepository(prisma);
  const prefix = `persistence-hardening-${randomUUID()}`;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.idempotencyRecord.deleteMany({
      where: { idempotencyKey: { startsWith: prefix } },
    });
    await prisma.walletAccount.deleteMany({ where: { userId: { startsWith: prefix } } });
    await prisma.quote.deleteMany({ where: { userId: { startsWith: prefix } } });
    await prisma.conversion.deleteMany({ where: { userId: { startsWith: prefix } } });
    await prisma.processedMessage.deleteMany({ where: { conversionId: { startsWith: prefix } } });
    await prisma.$disconnect();
  });

  it('rejects wallet rows that violate balance = available + reserved', async () => {
    await expect(
      prisma.walletAccount.create({
        data: {
          id: randomUUID(),
          userId: `${prefix}-wallet`,
          asset: 'USDT',
          balance: '100',
          available: '90',
          reserved: '5',
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects invalid quote, conversion, and processed-message states', async () => {
    await expect(
      prisma.quote.create({
        data: {
          id: randomUUID(),
          userId: `${prefix}-quote`,
          sourceAsset: 'USDT',
          targetAsset: 'USDT',
          sourceAmount: '10',
          targetAmount: '10',
          rate: '1',
          status: 'ACTIVE',
          createdAt: new Date('2026-08-06T00:00:00.000Z'),
          expiresAt: new Date('2026-08-06T00:00:20.000Z'),
        },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.conversion.create({
        data: {
          id: randomUUID(),
          quoteId: randomUUID(),
          userId: `${prefix}-conversion`,
          sourceAsset: 'USDT',
          targetAsset: 'BTC',
          sourceAmount: '10',
          targetAmount: '0.0005',
          status: 'COMPLETED',
          createdAt: new Date(),
        },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.processedMessage.create({
        data: {
          eventId: randomUUID(),
          conversionId: `${prefix}-processed`,
          outcome: 'CORRUPT',
        },
      }),
    ).rejects.toThrow();
  });

  it('enforces global idempotency-key uniqueness across scopes', async () => {
    const key = `${prefix}-global-key`;
    await prisma.idempotencyRecord.create({
      data: { scope: 'scope-a', idempotencyKey: key, requestHash: 'hash-a' },
    });

    await expect(
      prisma.idempotencyRecord.create({
        data: { scope: 'scope-b', idempotencyKey: key, requestHash: 'hash-b' },
      }),
    ).rejects.toThrow();
  });

  it('deletes only a bounded batch older than the retention cutoff', async () => {
    const oldDate = new Date('2026-08-01T00:00:00.000Z');
    const recentDate = new Date('2026-08-06T00:00:00.000Z');
    await prisma.idempotencyRecord.createMany({
      data: [
        {
          scope: 'retention',
          idempotencyKey: `${prefix}-old-1`,
          requestHash: 'hash',
          createdAt: oldDate,
        },
        {
          scope: 'retention',
          idempotencyKey: `${prefix}-old-2`,
          requestHash: 'hash',
          createdAt: oldDate,
        },
        {
          scope: 'retention',
          idempotencyKey: `${prefix}-old-3`,
          requestHash: 'hash',
          createdAt: oldDate,
        },
        {
          scope: 'retention',
          idempotencyKey: `${prefix}-recent`,
          requestHash: 'hash',
          createdAt: recentDate,
        },
      ],
    });

    await expect(idempotency.deleteExpired(new Date('2026-08-05T00:00:00.000Z'), 2)).resolves.toBe(
      2,
    );
    expect(
      await prisma.idempotencyRecord.count({
        where: { idempotencyKey: { startsWith: `${prefix}-old-` } },
      }),
    ).toBe(1);
    expect(
      await prisma.idempotencyRecord.count({
        where: { idempotencyKey: `${prefix}-recent` },
      }),
    ).toBe(1);
  });
});
