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
import { ProcessConversionExecutionUseCase } from '../src/modules/conversion/application/process-conversion-execution.use-case';
import { OutboxPublisherService } from '../src/modules/conversion/infrastructure/messaging/outbox-publisher.service';
import { FakeExchangeAdapter } from '../src/modules/conversion/infrastructure/fake-exchange.adapter';
import { ConversionExecutionRequestedPayload } from '../src/modules/conversion/domain/outbox-message';

/**
 * Requires `docker compose up -d postgres rabbitmq`.
 * Background publisher/consumer loops are disabled; tests drive publish + process explicitly.
 */
describe('Execution pipeline (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let processExecution: ProcessConversionExecutionUseCase;
  let publisher: OutboxPublisherService;
  let exchange: FakeExchangeAdapter;
  const userId = `exec-test-${randomUUID()}`;

  beforeAll(async () => {
    process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
    process.env.EXECUTION_CONSUMER_ENABLED = 'false';
    process.env.MESSAGING_ENABLED = 'true';
    process.env.FAKE_EXCHANGE_MODE = 'SUCCESS';

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
    publisher = app.get(OutboxPublisherService);
    exchange = app.get(FakeExchangeAdapter);

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
    const conversionIds = conversions.map((c) => c.id);
    await prisma.fakeExchangeExecution.deleteMany({
      where: { conversionId: { in: conversionIds } },
    });
    await prisma.processedMessage.deleteMany({ where: { conversionId: { in: conversionIds } } });
    await prisma.outboxMessage.deleteMany({ where: { aggregateId: { in: conversionIds } } });
    await prisma.idempotencyRecord.deleteMany({ where: { conversionId: { in: conversionIds } } });
    await prisma.conversion.deleteMany({ where: { userId } });
    await prisma.quote.deleteMany({ where: { userId } });
    await prisma.walletAccount.deleteMany({ where: { userId } });
    await app.close();
  });

  async function createAndAccept(sourceAmount: string): Promise<{
    quoteId: string;
    conversionId: string;
    eventPayload: ConversionExecutionRequestedPayload;
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
      quoteId,
      conversionId: body.conversionId,
      eventPayload: outbox.payload as unknown as ConversionExecutionRequestedPayload,
    };
  }

  it('publishes outbox events and settles a successful conversion (commit + credit)', async () => {
    exchange.setMode('SUCCESS');
    const { conversionId, eventPayload } = await createAndAccept('40');

    const published = await publisher.publishBatch();
    expect(published).toBeGreaterThanOrEqual(1);

    const outbox = await prisma.outboxMessage.findFirstOrThrow({
      where: { aggregateId: conversionId },
    });
    expect(outbox.publishedAt).not.toBeNull();

    await processExecution.execute(eventPayload);

    const conversion = await prisma.conversion.findUniqueOrThrow({ where: { id: conversionId } });
    expect(conversion.status).toBe('COMPLETED');
    expect(conversion.exchangeExecutionId).toBe(eventPayload.eventId);
    expect(conversion.completedAt).not.toBeNull();

    const usdt = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId_asset: { userId, asset: 'USDT' } },
    });
    // 100 - 40 committed
    expect(Number(usdt.balance)).toBe(60);
    expect(Number(usdt.reserved)).toBe(0);
    expect(Number(usdt.available)).toBe(60);

    const btc = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId_asset: { userId, asset: 'BTC' } },
    });
    expect(Number(btc.available)).toBeGreaterThan(0);

    const processed = await prisma.processedMessage.findUnique({
      where: { eventId: eventPayload.eventId },
    });
    expect(processed?.outcome).toBe('SUCCESS');
  });

  it('is idempotent on duplicate event delivery (no double settle)', async () => {
    exchange.setMode('SUCCESS');
    const { conversionId, eventPayload } = await createAndAccept('20');
    await publisher.publishBatch();
    await processExecution.execute(eventPayload);

    const usdtAfterFirst = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId_asset: { userId, asset: 'USDT' } },
    });

    await processExecution.execute(eventPayload);

    const usdtAfterSecond = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId_asset: { userId, asset: 'USDT' } },
    });
    expect(String(usdtAfterSecond.balance)).toBe(String(usdtAfterFirst.balance));
    expect(String(usdtAfterSecond.reserved)).toBe(String(usdtAfterFirst.reserved));

    const conversion = await prisma.conversion.findUniqueOrThrow({ where: { id: conversionId } });
    expect(conversion.status).toBe('COMPLETED');

    const processedCount = await prisma.processedMessage.count({
      where: { eventId: eventPayload.eventId },
    });
    expect(processedCount).toBe(1);
  });

  it('releases reserved funds when the fake exchange fails', async () => {
    exchange.setMode('FAILURE');
    const before = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId_asset: { userId, asset: 'USDT' } },
    });

    const { conversionId, eventPayload } = await createAndAccept('15');
    await processExecution.execute(eventPayload);

    const conversion = await prisma.conversion.findUniqueOrThrow({ where: { id: conversionId } });
    expect(conversion.status).toBe('FAILED');

    const after = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId_asset: { userId, asset: 'USDT' } },
    });
    expect(Number(after.reserved)).toBe(Number(before.reserved));
    expect(Number(after.available)).toBe(Number(before.available));
    expect(Number(after.balance)).toBe(Number(before.balance));
  });

  it('marks REQUIRES_RECONCILIATION on UNKNOWN without mutating the wallet', async () => {
    exchange.setMode('UNKNOWN');
    const before = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId_asset: { userId, asset: 'USDT' } },
    });

    const { conversionId, eventPayload } = await createAndAccept('10');
    await processExecution.execute(eventPayload);

    const conversion = await prisma.conversion.findUniqueOrThrow({ where: { id: conversionId } });
    expect(conversion.status).toBe('REQUIRES_RECONCILIATION');

    const after = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId_asset: { userId, asset: 'USDT' } },
    });
    // Still reserved (not released, not committed)
    expect(Number(after.reserved)).toBe(Number(before.reserved) + 10);
    expect(Number(after.available)).toBe(Number(before.available) - 10);
  });

  it('CONCURRENCY: only one of two simultaneous 80 USDT accepts against 100 USDT succeeds', async () => {
    // Fresh wallet for this scenario
    const concurrentUser = `exec-concurrent-${randomUUID()}`;
    const usdt = WalletAccount.open(
      randomUUID(),
      UserId.of(concurrentUser),
      USDT,
      Money.of('100', USDT),
    );
    await prisma.walletAccount.create({
      data: {
        id: usdt.id,
        userId: concurrentUser,
        asset: 'USDT',
        balance: '100',
        available: '100',
        reserved: '0',
      },
    });

    const server = app.getHttpServer() as App;
    const quoteA = await request(server).post('/quotes').send({
      userId: concurrentUser,
      sourceAsset: 'USDT',
      targetAsset: 'BTC',
      sourceAmount: '80',
    });
    const quoteB = await request(server).post('/quotes').send({
      userId: concurrentUser,
      sourceAsset: 'USDT',
      targetAsset: 'BTC',
      sourceAmount: '80',
    });
    expect(quoteA.status).toBe(201);
    expect(quoteB.status).toBe(201);

    const [resA, resB] = await Promise.all([
      request(server)
        .post(`/quotes/${(quoteA.body as { quoteId: string }).quoteId}/accept`)
        .set('Idempotency-Key', randomUUID())
        .send(),
      request(server)
        .post(`/quotes/${(quoteB.body as { quoteId: string }).quoteId}/accept`)
        .set('Idempotency-Key', randomUUID())
        .send(),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 409]);

    const wallet = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId_asset: { userId: concurrentUser, asset: 'USDT' } },
    });
    expect(Number(wallet.available)).toBe(20);
    expect(Number(wallet.reserved)).toBe(80);
    expect(Number(wallet.balance)).toBe(100);
    expect(Number(wallet.available)).toBeGreaterThanOrEqual(0);

    // cleanup
    const conversions = await prisma.conversion.findMany({ where: { userId: concurrentUser } });
    const ids = conversions.map((c) => c.id);
    await prisma.outboxMessage.deleteMany({ where: { aggregateId: { in: ids } } });
    await prisma.idempotencyRecord.deleteMany({ where: { conversionId: { in: ids } } });
    await prisma.conversion.deleteMany({ where: { userId: concurrentUser } });
    await prisma.quote.deleteMany({ where: { userId: concurrentUser } });
    await prisma.walletAccount.deleteMany({ where: { userId: concurrentUser } });
  });
});
