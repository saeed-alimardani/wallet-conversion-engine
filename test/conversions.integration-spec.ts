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
import { ConversionStatusResponse } from '../src/modules/conversion/application/get-conversion.use-case';
import { ProcessConversionExecutionUseCase } from '../src/modules/conversion/application/process-conversion-execution.use-case';
import { FakeExchangeAdapter } from '../src/modules/conversion/infrastructure/fake-exchange.adapter';
import { ConversionExecutionRequestedPayload } from '../src/modules/conversion/domain/outbox-message';

/**
 * Requires `docker compose up -d postgres`.
 * Covers GET /conversions/:id across lifecycle states and edge cases.
 */
describe('GET /conversions/:conversionId (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let processExecution: ProcessConversionExecutionUseCase;
  let exchange: FakeExchangeAdapter;
  const userId = `conv-query-${randomUUID()}`;

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
    processExecution = app.get(ProcessConversionExecutionUseCase);
    exchange = app.get(FakeExchangeAdapter);

    const usdt = WalletAccount.open(randomUUID(), UserId.of(userId), USDT, Money.of('200', USDT));
    const btc = WalletAccount.open(randomUUID(), UserId.of(userId), BTC, Money.of('0', BTC));
    await prisma.walletAccount.createMany({
      data: [
        {
          id: usdt.id,
          userId,
          asset: 'USDT',
          balance: '200',
          available: '200',
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
    await prisma.processedMessage.deleteMany({ where: { conversionId: { in: ids } } });
    await prisma.outboxMessage.deleteMany({ where: { aggregateId: { in: ids } } });
    await prisma.idempotencyRecord.deleteMany({ where: { conversionId: { in: ids } } });
    await prisma.conversion.deleteMany({ where: { userId } });
    await prisma.quote.deleteMany({ where: { userId } });
    await prisma.walletAccount.deleteMany({ where: { userId } });
    await app.close();
  });

  async function acceptAmount(sourceAmount: string): Promise<{
    conversionId: string;
    payload: ConversionExecutionRequestedPayload;
  }> {
    const server = app.getHttpServer() as App;
    const quoteRes = await request(server).post('/quotes').send({
      userId,
      sourceAsset: 'USDT',
      targetAsset: 'BTC',
      sourceAmount,
    });
    expect(quoteRes.status).toBe(201);
    const quoteId = (quoteRes.body as { quoteId: string }).quoteId;

    const acceptRes = await request(server)
      .post(`/quotes/${quoteId}/accept`)
      .set('Idempotency-Key', randomUUID())
      .send();
    expect(acceptRes.status).toBe(201);
    const body = acceptRes.body as AcceptQuoteSuccessBody;
    const outbox = await prisma.outboxMessage.findFirstOrThrow({
      where: { aggregateId: body.conversionId },
    });
    return {
      conversionId: body.conversionId,
      payload: outbox.payload as unknown as ConversionExecutionRequestedPayload,
    };
  }

  it('returns FUNDS_RESERVED immediately after accept (before execution)', async () => {
    const { conversionId } = await acceptAmount('25');
    const server = app.getHttpServer() as App;
    const res = await request(server).get(`/conversions/${conversionId}`);
    expect(res.status).toBe(200);
    const body = res.body as ConversionStatusResponse;
    expect(body).toMatchObject({
      conversionId,
      status: 'FUNDS_RESERVED',
      sourceAsset: 'USDT',
      targetAsset: 'BTC',
      sourceAmount: '25',
      completedAt: null,
    });
    expect(typeof body.createdAt).toBe('string');
    expect(typeof body.targetAmount).toBe('string');
  });

  it('returns COMPLETED after successful execution', async () => {
    exchange.setMode('SUCCESS');
    exchange.clearMemoizedResults();
    const { conversionId, payload } = await acceptAmount('20');
    await processExecution.execute(payload);

    const server = app.getHttpServer() as App;
    const res = await request(server).get(`/conversions/${conversionId}`);
    expect(res.status).toBe(200);
    const body = res.body as ConversionStatusResponse;
    expect(body.status).toBe('COMPLETED');
    expect(body.completedAt).not.toBeNull();
  });

  it('returns FAILED after exchange failure (funds released)', async () => {
    exchange.setMode('FAILURE');
    exchange.clearMemoizedResults();
    const { conversionId, payload } = await acceptAmount('15');
    await processExecution.execute(payload);

    const server = app.getHttpServer() as App;
    const res = await request(server).get(`/conversions/${conversionId}`);
    expect(res.status).toBe(200);
    expect((res.body as ConversionStatusResponse).status).toBe('FAILED');
  });

  it('returns REQUIRES_RECONCILIATION after UNKNOWN exchange timeout', async () => {
    exchange.setMode('UNKNOWN');
    exchange.clearMemoizedResults();
    const { conversionId, payload } = await acceptAmount('10');
    await processExecution.execute(payload);

    const server = app.getHttpServer() as App;
    const res = await request(server).get(`/conversions/${conversionId}`);
    expect(res.status).toBe(200);
    expect((res.body as ConversionStatusResponse).status).toBe('REQUIRES_RECONCILIATION');
  });

  it('returns 404 for an unknown conversionId', async () => {
    const server = app.getHttpServer() as App;
    const res = await request(server).get(`/conversions/${randomUUID()}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errorCode: 'CONVERSION_NOT_FOUND' });
  });

  it('returns 400 INVALID_CONVERSION_ID for whitespace-only id', async () => {
    const server = app.getHttpServer() as App;
    // Encode spaces so the path segment is preserved
    const res = await request(server).get(`/conversions/${encodeURIComponent('   ')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errorCode: 'INVALID_CONVERSION_ID' });
  });

  it('is stable across repeated GETs (read-only, no state change)', async () => {
    exchange.setMode('SUCCESS');
    exchange.clearMemoizedResults();
    const { conversionId, payload } = await acceptAmount('5');
    await processExecution.execute(payload);

    const server = app.getHttpServer() as App;
    const first = await request(server).get(`/conversions/${conversionId}`);
    const second = await request(server).get(`/conversions/${conversionId}`);
    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });
});
