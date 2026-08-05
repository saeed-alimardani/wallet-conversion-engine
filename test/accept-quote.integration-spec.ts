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
import { AcceptQuoteSuccessBody } from '../src/modules/conversion/application/accept-quote.use-case';

/**
 * Requires `docker compose up -d postgres`.
 * Covers atomic accept (quote + wallet reserve + conversion + outbox) and
 * Stripe-style idempotency replay for duplicate Idempotency-Key.
 */
describe('Accept quote (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const userId = `accept-test-${randomUUID()}`;
  const createdQuoteIds: string[] = [];
  const createdConversionIds: string[] = [];

  beforeAll(async () => {
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
    await prisma.outboxMessage.deleteMany({
      where: { aggregateId: { in: createdConversionIds } },
    });
    await prisma.idempotencyRecord.deleteMany({
      where: { scope: { contains: createdQuoteIds[0] ?? 'none' } },
    });
    // Clean broader: by user
    const conversions = await prisma.conversion.findMany({ where: { userId } });
    const conversionIds = conversions.map((c) => c.id);
    await prisma.outboxMessage.deleteMany({ where: { aggregateId: { in: conversionIds } } });
    await prisma.idempotencyRecord.deleteMany({
      where: { conversionId: { in: conversionIds } },
    });
    await prisma.conversion.deleteMany({ where: { userId } });
    await prisma.quote.deleteMany({ where: { userId } });
    await prisma.walletAccount.deleteMany({ where: { userId } });
    await app.close();
  });

  async function createQuote(sourceAmount = '80'): Promise<string> {
    const server = app.getHttpServer() as App;
    const response = await request(server).post('/quotes').send({
      userId,
      sourceAsset: 'USDT',
      targetAsset: 'BTC',
      sourceAmount,
    });
    expect(response.status).toBe(201);
    const quoteId = (response.body as { quoteId: string }).quoteId;
    createdQuoteIds.push(quoteId);
    return quoteId;
  }

  it('atomically accepts a quote: reserves wallet, creates conversion, writes outbox', async () => {
    const quoteId = await createQuote('80');
    const server = app.getHttpServer() as App;
    const idempotencyKey = randomUUID();

    const response = await request(server)
      .post(`/quotes/${quoteId}/accept`)
      .set('Idempotency-Key', idempotencyKey)
      .send();

    expect(response.status).toBe(201);
    const body = response.body as AcceptQuoteSuccessBody;
    expect(body).toMatchObject({
      quoteId,
      userId,
      status: 'FUNDS_RESERVED',
      sourceAsset: 'USDT',
      targetAsset: 'BTC',
      sourceAmount: '80',
    });
    createdConversionIds.push(body.conversionId);

    const quote = await prisma.quote.findUniqueOrThrow({ where: { id: quoteId } });
    expect(quote.status).toBe('ACCEPTED');
    expect(quote.acceptedAt).not.toBeNull();

    const wallet = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId_asset: { userId, asset: 'USDT' } },
    });
    expect(String(wallet.available)).toBe('20');
    expect(String(wallet.reserved)).toBe('80');
    expect(String(wallet.balance)).toBe('100');

    const conversion = await prisma.conversion.findUniqueOrThrow({
      where: { id: body.conversionId },
    });
    expect(conversion.status).toBe('FUNDS_RESERVED');
    expect(conversion.quoteId).toBe(quoteId);

    const outbox = await prisma.outboxMessage.findMany({
      where: { aggregateId: body.conversionId },
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0].eventType).toBe('ConversionExecutionRequested');
    expect(outbox[0].publishedAt).toBeNull();
    const payload = outbox[0].payload as { conversionId: string; eventType: string };
    expect(payload.conversionId).toBe(body.conversionId);
    expect(payload.eventType).toBe('ConversionExecutionRequested');
  });

  it('replays the same logical result for a duplicate Idempotency-Key (no double reserve)', async () => {
    // Reset wallet to 100 available for a clean second scenario
    await prisma.walletAccount.update({
      where: { userId_asset: { userId, asset: 'USDT' } },
      data: { available: '100', reserved: '0', balance: '100' },
    });

    const quoteId = await createQuote('50');
    const server = app.getHttpServer() as App;
    const idempotencyKey = randomUUID();

    const first = await request(server)
      .post(`/quotes/${quoteId}/accept`)
      .set('Idempotency-Key', idempotencyKey)
      .send();
    expect(first.status).toBe(201);
    const firstBody = first.body as AcceptQuoteSuccessBody;
    createdConversionIds.push(firstBody.conversionId);

    const second = await request(server)
      .post(`/quotes/${quoteId}/accept`)
      .set('Idempotency-Key', idempotencyKey)
      .send();
    expect(second.status).toBe(201);
    const secondBody = second.body as AcceptQuoteSuccessBody;
    expect(secondBody.conversionId).toBe(firstBody.conversionId);

    const wallet = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId_asset: { userId, asset: 'USDT' } },
    });
    expect(String(wallet.available)).toBe('50');
    expect(String(wallet.reserved)).toBe('50');

    const conversions = await prisma.conversion.findMany({ where: { quoteId } });
    expect(conversions).toHaveLength(1);

    const outbox = await prisma.outboxMessage.findMany({
      where: { aggregateId: firstBody.conversionId },
    });
    expect(outbox).toHaveLength(1);
  });

  it('rejects accept without Idempotency-Key', async () => {
    const quoteId = await createQuote('10');
    const server = app.getHttpServer() as App;
    const response = await request(server).post(`/quotes/${quoteId}/accept`).send();
    expect(response.status).toBe(400);
  });
});
