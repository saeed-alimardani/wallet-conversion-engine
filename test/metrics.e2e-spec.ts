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
import { ProcessConversionExecutionUseCase } from '../src/modules/conversion/application/process-conversion-execution.use-case';
import { FakeExchangeAdapter } from '../src/modules/conversion/infrastructure/fake-exchange.adapter';
import { ConversionExecutionRequestedPayload } from '../src/modules/conversion/domain/outbox-message';
import { AcceptQuoteSuccessBody } from '../src/modules/conversion/application/accept-quote.use-case';

const REQUIRED_METRIC_NAMES = [
  'quote_created_total',
  'quote_acceptance_total',
  'quote_acceptance_failed_total',
  'conversion_completed_total',
  'conversion_failed_total',
  'outbox_pending_count',
  'outbox_publish_failure_total',
  'execution_retry_total',
  'http_request_duration_seconds',
  'wallet_reservation_conflict_total',
  'event_processing_duration_seconds',
];

describe('Observability /metrics (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let processExecution: ProcessConversionExecutionUseCase;
  let exchange: FakeExchangeAdapter;
  const userId = `metrics-${randomUUID()}`;

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

    const usdt = WalletAccount.open(randomUUID(), UserId.of(userId), USDT, Money.of('50', USDT));
    await prisma.walletAccount.create({
      data: {
        id: usdt.id,
        userId,
        asset: 'USDT',
        balance: '50',
        available: '50',
        reserved: '0',
      },
    });
    const btc = WalletAccount.open(randomUUID(), UserId.of(userId), BTC, Money.of('0', BTC));
    await prisma.walletAccount.create({
      data: {
        id: btc.id,
        userId,
        asset: 'BTC',
        balance: '0',
        available: '0',
        reserved: '0',
      },
    });
  });

  afterAll(async () => {
    const conversions = await prisma.conversion.findMany({ where: { userId } });
    const ids = conversions.map((c) => c.id);
    await prisma.fakeExchangeExecution.deleteMany({ where: { conversionId: { in: ids } } });
    await prisma.processedMessage.deleteMany({ where: { conversionId: { in: ids } } });
    await prisma.outboxMessage.deleteMany({ where: { aggregateId: { in: ids } } });
    await prisma.idempotencyRecord.deleteMany({ where: { conversionId: { in: ids } } });
    await prisma.conversion.deleteMany({ where: { userId } });
    await prisma.quote.deleteMany({ where: { userId } });
    await prisma.walletAccount.deleteMany({ where: { userId } });
    await app.close();
  });

  async function scrape(): Promise<string> {
    const server = app.getHttpServer() as App;
    const res = await request(server).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    return res.text;
  }

  it('exposes all required Prometheus metric names', async () => {
    const text = await scrape();
    for (const name of REQUIRED_METRIC_NAMES) {
      expect(text).toContain(name);
    }
  });

  it('increments quote_created_total and quote_acceptance_total on the happy path', async () => {
    const before = await scrape();
    const createdBefore = Number(before.match(/quote_created_total\s+(\d+)/)?.[1] ?? '0');
    const acceptedBefore = Number(before.match(/quote_acceptance_total\s+(\d+)/)?.[1] ?? '0');

    const server = app.getHttpServer() as App;
    const quoteRes = await request(server).post('/quotes').send({
      userId,
      sourceAsset: 'USDT',
      targetAsset: 'BTC',
      sourceAmount: '10',
    });
    expect(quoteRes.status).toBe(201);

    const acceptRes = await request(server)
      .post(`/quotes/${(quoteRes.body as { quoteId: string }).quoteId}/accept`)
      .set('Idempotency-Key', randomUUID())
      .send();
    expect(acceptRes.status).toBe(201);

    const after = await scrape();
    const createdAfter = Number(after.match(/quote_created_total\s+(\d+)/)?.[1] ?? '0');
    const acceptedAfter = Number(after.match(/quote_acceptance_total\s+(\d+)/)?.[1] ?? '0');
    expect(createdAfter).toBeGreaterThanOrEqual(createdBefore + 1);
    expect(acceptedAfter).toBeGreaterThanOrEqual(acceptedBefore + 1);
    expect(after).toMatch(/outbox_pending_count\s+[1-9]/);
  });

  it('increments quote_acceptance_failed_total and wallet_reservation_conflict_total on overspend', async () => {
    const before = await scrape();
    const failedBefore = Number(
      before.match(
        /quote_acceptance_failed_total\{error_code="INSUFFICIENT_AVAILABLE_BALANCE"\}\s+(\d+)/,
      )?.[1] ?? '0',
    );
    const conflictBefore = Number(
      before.match(/wallet_reservation_conflict_total\s+(\d+)/)?.[1] ?? '0',
    );

    const server = app.getHttpServer() as App;
    // Wallet has at most ~40 left after prior test; request 80 to force conflict.
    const quoteRes = await request(server).post('/quotes').send({
      userId,
      sourceAsset: 'USDT',
      targetAsset: 'BTC',
      sourceAmount: '80',
    });
    const acceptRes = await request(server)
      .post(`/quotes/${(quoteRes.body as { quoteId: string }).quoteId}/accept`)
      .set('Idempotency-Key', randomUUID())
      .send();
    expect(acceptRes.status).toBe(409);

    const after = await scrape();
    const failedAfter = Number(
      after.match(
        /quote_acceptance_failed_total\{error_code="INSUFFICIENT_AVAILABLE_BALANCE"\}\s+(\d+)/,
      )?.[1] ?? '0',
    );
    const conflictAfter = Number(
      after.match(/wallet_reservation_conflict_total\s+(\d+)/)?.[1] ?? '0',
    );
    expect(failedAfter).toBeGreaterThanOrEqual(failedBefore + 1);
    expect(conflictAfter).toBeGreaterThanOrEqual(conflictBefore + 1);
  });

  it('increments conversion_completed_total and execution_retry_total on settle + duplicate delivery', async () => {
    exchange.setMode('SUCCESS');
    const before = await scrape();
    const completedBefore = Number(before.match(/conversion_completed_total\s+(\d+)/)?.[1] ?? '0');
    const retryBefore = Number(before.match(/execution_retry_total\s+(\d+)/)?.[1] ?? '0');

    const server = app.getHttpServer() as App;
    // Top up wallet for this scenario
    await prisma.walletAccount.update({
      where: { userId_asset: { userId, asset: 'USDT' } },
      data: { balance: '100', available: '100', reserved: '0' },
    });

    const quoteRes = await request(server).post('/quotes').send({
      userId,
      sourceAsset: 'USDT',
      targetAsset: 'BTC',
      sourceAmount: '12',
    });
    const acceptRes = await request(server)
      .post(`/quotes/${(quoteRes.body as { quoteId: string }).quoteId}/accept`)
      .set('Idempotency-Key', randomUUID())
      .send();
    const body = acceptRes.body as AcceptQuoteSuccessBody;
    const outbox = await prisma.outboxMessage.findFirstOrThrow({
      where: { aggregateId: body.conversionId },
    });
    const payload = outbox.payload as unknown as ConversionExecutionRequestedPayload;

    await processExecution.execute(payload);
    await processExecution.execute(payload); // duplicate → retry metric

    const after = await scrape();
    const completedAfter = Number(after.match(/conversion_completed_total\s+(\d+)/)?.[1] ?? '0');
    const retryAfter = Number(after.match(/execution_retry_total\s+(\d+)/)?.[1] ?? '0');
    expect(completedAfter).toBeGreaterThanOrEqual(completedBefore + 1);
    expect(retryAfter).toBeGreaterThanOrEqual(retryBefore + 1);
    expect(after).toContain('event_processing_duration_seconds_bucket');
    expect(after).toContain('http_request_duration_seconds_bucket');
  });

  it('does not put high-cardinality ids into metric label sets', async () => {
    const text = await scrape();
    expect(text).not.toMatch(/userId=/i);
    expect(text).not.toMatch(/conversion_id=/i);
    expect(text).not.toMatch(/quote_id=/i);
  });
});
