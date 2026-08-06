import { randomUUID } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/modules/shared/infrastructure/prisma/prisma.service';
import { WalletAccount } from '../src/modules/wallet/domain/wallet-account';
import { UserId } from '../src/modules/shared/domain/user-id';
import { Money } from '../src/modules/shared/domain/money';
import { USDT, BTC } from '../src/modules/shared/domain/asset';

/**
 * Failure-path hardening for accept (Feature 5). Requires Postgres.
 */
describe('Accept failure paths (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const userId = `accept-fail-${randomUUID()}`;

  beforeAll(async () => {
    process.env.MESSAGING_ENABLED = 'false';
    process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
    process.env.EXECUTION_CONSUMER_ENABLED = 'false';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
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
    await prisma.outboxMessage.deleteMany({ where: { aggregateId: { in: ids } } });
    await prisma.idempotencyRecord.deleteMany({ where: { conversionId: { in: ids } } });
    await prisma.conversion.deleteMany({ where: { userId } });
    await prisma.quote.deleteMany({ where: { userId } });
    await prisma.walletAccount.deleteMany({ where: { userId } });
    await app.close();
  });

  async function createQuote(sourceAmount = '30'): Promise<string> {
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

  it('returns 404 QUOTE_NOT_FOUND for an unknown quoteId', async () => {
    const server = app.getHttpServer() as App;
    const res = await request(server)
      .post(`/quotes/${randomUUID()}/accept`)
      .set('Idempotency-Key', randomUUID())
      .send();
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errorCode: 'QUOTE_NOT_FOUND' });
  });

  it('returns 409 QUOTE_EXPIRED when the quote TTL has elapsed', async () => {
    const quoteId = await createQuote('10');
    await prisma.quote.update({
      where: { id: quoteId },
      data: {
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
        expiresAt: new Date('2020-01-01T00:00:20.000Z'),
      },
    });

    const server = app.getHttpServer() as App;
    const res = await request(server)
      .post(`/quotes/${quoteId}/accept`)
      .set('Idempotency-Key', randomUUID())
      .send();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ errorCode: 'QUOTE_EXPIRED' });

    // No conversion / outbox / wallet mutation
    expect(await prisma.conversion.count({ where: { quoteId } })).toBe(0);
    const wallet = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId_asset: { userId, asset: 'USDT' } },
    });
    expect(Number(wallet.reserved)).toBe(0);
  });

  it('returns 409 QUOTE_ALREADY_ACCEPTED for a second distinct idempotency key', async () => {
    const quoteId = await createQuote('20');
    const server = app.getHttpServer() as App;

    const first = await request(server)
      .post(`/quotes/${quoteId}/accept`)
      .set('Idempotency-Key', randomUUID())
      .send();
    expect(first.status).toBe(201);

    const second = await request(server)
      .post(`/quotes/${quoteId}/accept`)
      .set('Idempotency-Key', randomUUID())
      .send();
    expect(second.status).toBe(409);
    const body = second.body as { errorCode: string };
    expect(body.errorCode).toMatch(/QUOTE_ALREADY_ACCEPTED|QUOTE_ACCEPT_CONFLICT/);

    expect(await prisma.conversion.count({ where: { quoteId } })).toBe(1);
  });

  it('returns 409 IDEMPOTENCY_KEY_REUSE for a preclaimed key with another fingerprint', async () => {
    const quoteId = await createQuote('5');
    const key = randomUUID();
    await prisma.idempotencyRecord.create({
      data: {
        scope: 'POST:/quotes/:quoteId/accept',
        idempotencyKey: key,
        requestHash: 'not-the-real-hash',
        responseStatus: 201,
        responseBody: { conversionId: 'x' },
        conversionId: 'x',
      },
    });

    const server = app.getHttpServer() as App;
    const res = await request(server)
      .post(`/quotes/${quoteId}/accept`)
      .set('Idempotency-Key', key)
      .send();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ errorCode: 'IDEMPOTENCY_KEY_REUSE' });
  });

  it('returns 409 INSUFFICIENT_AVAILABLE_BALANCE without mutating the wallet', async () => {
    await prisma.walletAccount.update({
      where: { userId_asset: { userId, asset: 'USDT' } },
      data: { balance: '100', available: '100', reserved: '0' },
    });

    const quoteId = await createQuote('100');
    // Drain available with a prior accept
    const server = app.getHttpServer() as App;
    const first = await request(server)
      .post(`/quotes/${quoteId}/accept`)
      .set('Idempotency-Key', randomUUID())
      .send();
    expect(first.status).toBe(201);

    const oversized = await createQuote('1');
    const before = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId_asset: { userId, asset: 'USDT' } },
    });

    const res = await request(server)
      .post(`/quotes/${oversized}/accept`)
      .set('Idempotency-Key', randomUUID())
      .send();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ errorCode: 'INSUFFICIENT_AVAILABLE_BALANCE' });

    const after = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId_asset: { userId, asset: 'USDT' } },
    });
    expect(String(after.available)).toBe(String(before.available));
    expect(String(after.reserved)).toBe(String(before.reserved));
    expect(await prisma.conversion.count({ where: { quoteId: oversized } })).toBe(0);
  });

  it('does not leave a poisoned idempotency key after a failed accept', async () => {
    // Prior tests may have drained available; restore a clean wallet for the retry.
    await prisma.walletAccount.update({
      where: { userId_asset: { userId, asset: 'USDT' } },
      data: { balance: '100', available: '100', reserved: '0' },
    });

    const quoteId = await createQuote('10');
    await prisma.quote.update({
      where: { id: quoteId },
      data: {
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
        expiresAt: new Date('2020-01-01T00:00:20.000Z'),
      },
    });
    const key = randomUUID();
    const server = app.getHttpServer() as App;

    const failed = await request(server)
      .post(`/quotes/${quoteId}/accept`)
      .set('Idempotency-Key', key)
      .send();
    expect(failed.status).toBe(409);

    // Revive the quote and retry with the same key — claim was rolled back.
    await prisma.quote.update({
      where: { id: quoteId },
      data: {
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        status: 'ACTIVE',
        acceptedAt: null,
      },
    });

    const retry = await request(server)
      .post(`/quotes/${quoteId}/accept`)
      .set('Idempotency-Key', key)
      .send();
    expect(retry.status).toBe(201);
  });
});
