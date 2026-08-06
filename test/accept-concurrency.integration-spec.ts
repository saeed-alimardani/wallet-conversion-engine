import { createHash, randomUUID } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/modules/shared/infrastructure/prisma/prisma.service';
import { WalletAccount } from '../src/modules/wallet/domain/wallet-account';
import { UserId } from '../src/modules/shared/domain/user-id';
import { Money } from '../src/modules/shared/domain/money';
import { USDT, BTC } from '../src/modules/shared/domain/asset';
import { AcceptQuoteSuccessBody } from '../src/modules/conversion/application/accept-quote.use-case';

/**
 * Race conditions on accept. Requires Postgres.
 */
describe('Accept concurrency / race conditions (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const userId = `accept-race-${randomUUID()}`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);

    const usdt = WalletAccount.open(randomUUID(), UserId.of(userId), USDT, Money.of('100', USDT));
    const btc = WalletAccount.open(randomUUID(), UserId.of(userId), BTC, Money.of('0', BTC));
    await prisma.walletAccount.createMany({
      data: [
        {
          id: usdt.id,
          userId,
          asset: 'USDT',
          balance: '100',
          available: '100',
          reserved: '0',
        },
        {
          id: btc.id,
          userId,
          asset: 'BTC',
          balance: '0',
          available: '0',
          reserved: '0',
        },
      ],
    });
  });

  afterAll(async () => {
    const conversions = await prisma.conversion.findMany({ where: { userId } });
    const ids = conversions.map((c) => c.id);
    const quotes = await prisma.quote.findMany({ where: { userId }, select: { id: true } });
    const quoteIds = quotes.map((q) => q.id);
    await prisma.outboxMessage.deleteMany({ where: { aggregateId: { in: ids } } });
    await prisma.idempotencyRecord.deleteMany({ where: { conversionId: { in: ids } } });
    if (quoteIds.length > 0) {
      await prisma.idempotencyRecord.deleteMany({
        where: { scope: { in: quoteIds.map((id) => `POST:/quotes/${id}/accept`) } },
      });
    }
    await prisma.conversion.deleteMany({ where: { userId } });
    await prisma.quote.deleteMany({ where: { userId } });
    await prisma.walletAccount.deleteMany({ where: { userId } });
    await app.close();
  });

  async function createQuote(sourceAmount: string): Promise<string> {
    const server = app.getHttpServer() as App;
    const res = await request(server).post('/quotes').send({
      userId,
      sourceAsset: 'USDT',
      targetAsset: 'BTC',
      sourceAmount,
    });
    expect(res.status).toBe(201);
    return (res.body as { quoteId: string }).quoteId;
  }

  it('same quote + two distinct keys concurrently: one 201, one 409; single conversion', async () => {
    const quoteId = await createQuote('25');
    const server = app.getHttpServer() as App;

    const [a, b] = await Promise.all([
      request(server).post(`/quotes/${quoteId}/accept`).set('Idempotency-Key', randomUUID()).send(),
      request(server).post(`/quotes/${quoteId}/accept`).set('Idempotency-Key', randomUUID()).send(),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    expect(await prisma.conversion.count({ where: { quoteId } })).toBe(1);

    const wallet = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId_asset: { userId, asset: 'USDT' } },
    });
    expect(Number(wallet.reserved)).toBe(25);
    expect(Number(wallet.available)).toBe(75);
  });

  it('same quote + same key concurrently: both 201 with identical conversionId', async () => {
    // Reset wallet for a clean reserve amount
    await prisma.walletAccount.update({
      where: { userId_asset: { userId, asset: 'USDT' } },
      data: { balance: '100', available: '100', reserved: '0' },
    });

    const quoteId = await createQuote('15');
    const key = randomUUID();
    const server = app.getHttpServer() as App;

    const [a, b] = await Promise.all([
      request(server).post(`/quotes/${quoteId}/accept`).set('Idempotency-Key', key).send(),
      request(server).post(`/quotes/${quoteId}/accept`).set('Idempotency-Key', key).send(),
    ]);

    // Winner creates; loser waits outside the TX for the stored response and replays 201.
    expect([a.status, b.status]).toEqual([201, 201]);
    const conversionIds = [a, b].map((r) => (r.body as AcceptQuoteSuccessBody).conversionId);
    expect(new Set(conversionIds).size).toBe(1);
    expect(await prisma.conversion.count({ where: { quoteId } })).toBe(1);
    expect(await prisma.outboxMessage.count({ where: { aggregateId: conversionIds[0] } })).toBe(1);

    const wallet = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId_asset: { userId, asset: 'USDT' } },
    });
    expect(Number(wallet.reserved)).toBe(15);
  });

  it('returns 409 IDEMPOTENCY_IN_PROGRESS when a stuck claim never completes', async () => {
    const quoteId = await createQuote('5');
    const key = randomUUID();
    await prisma.idempotencyRecord.create({
      data: {
        scope: `POST:/quotes/${quoteId}/accept`,
        idempotencyKey: key,
        requestHash: createHash('sha256').update(quoteId).digest('hex'),
        responseStatus: null,
        responseBody: Prisma.DbNull,
        conversionId: null,
      },
    });

    const previousWait = process.env.IDEMPOTENCY_IN_PROGRESS_WAIT_MS;
    const previousPoll = process.env.IDEMPOTENCY_IN_PROGRESS_POLL_MS;
    process.env.IDEMPOTENCY_IN_PROGRESS_WAIT_MS = '80';
    process.env.IDEMPOTENCY_IN_PROGRESS_POLL_MS = '20';
    try {
      const server = app.getHttpServer() as App;
      const res = await request(server)
        .post(`/quotes/${quoteId}/accept`)
        .set('Idempotency-Key', key)
        .send();
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ errorCode: 'IDEMPOTENCY_IN_PROGRESS' });
    } finally {
      if (previousWait === undefined) {
        delete process.env.IDEMPOTENCY_IN_PROGRESS_WAIT_MS;
      } else {
        process.env.IDEMPOTENCY_IN_PROGRESS_WAIT_MS = previousWait;
      }
      if (previousPoll === undefined) {
        delete process.env.IDEMPOTENCY_IN_PROGRESS_POLL_MS;
      } else {
        process.env.IDEMPOTENCY_IN_PROGRESS_POLL_MS = previousPoll;
      }
    }
  });
});
