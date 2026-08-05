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
import { FakeExchangeAdapter } from '../src/modules/conversion/infrastructure/fake-exchange.adapter';
import { ConversionExecutionRequestedPayload } from '../src/modules/conversion/domain/outbox-message';

/**
 * Concurrent duplicate delivery + repair paths. Requires Postgres.
 */
describe('Execution race conditions (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let processExecution: ProcessConversionExecutionUseCase;
  let exchange: FakeExchangeAdapter;
  const userId = `exec-race-${randomUUID()}`;

  beforeAll(async () => {
    process.env.MESSAGING_ENABLED = 'false';
    process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
    process.env.EXECUTION_CONSUMER_ENABLED = 'false';
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

  async function createAndAccept(sourceAmount: string): Promise<{
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
      conversionId: body.conversionId,
      eventPayload: outbox.payload as unknown as ConversionExecutionRequestedPayload,
    };
  }

  it('concurrent duplicate delivery settles the wallet exactly once', async () => {
    exchange.setMode('SUCCESS');
    exchange.clearMemoizedResults();

    const before = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId_asset: { userId, asset: 'USDT' } },
    });

    const { conversionId, eventPayload } = await createAndAccept('30');

    await Promise.all([
      processExecution.execute(eventPayload),
      processExecution.execute(eventPayload),
      processExecution.execute(eventPayload),
    ]);

    const conversion = await prisma.conversion.findUniqueOrThrow({ where: { id: conversionId } });
    expect(conversion.status).toBe('COMPLETED');

    const usdt = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId_asset: { userId, asset: 'USDT' } },
    });
    expect(Number(usdt.balance)).toBe(Number(before.balance) - 30);
    expect(Number(usdt.reserved)).toBe(Number(before.reserved));
    expect(Number(usdt.available)).toBe(Number(before.available) - 30);

    expect(await prisma.processedMessage.count({ where: { eventId: eventPayload.eventId } })).toBe(
      1,
    );

    const btc = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId_asset: { userId, asset: 'BTC' } },
    });
    expect(Number(btc.available)).toBeGreaterThan(0);
  });

  it('repairs terminal conversion missing processed_messages without re-settling', async () => {
    exchange.setMode('SUCCESS');
    exchange.clearMemoizedResults();

    const { conversionId, eventPayload } = await createAndAccept('10');
    await processExecution.execute(eventPayload);

    const usdtAfter = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId_asset: { userId, asset: 'USDT' } },
    });
    const btcAfter = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId_asset: { userId, asset: 'BTC' } },
    });

    await prisma.processedMessage.delete({ where: { eventId: eventPayload.eventId } });

    await processExecution.execute(eventPayload);

    const usdtRepair = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId_asset: { userId, asset: 'USDT' } },
    });
    const btcRepair = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId_asset: { userId, asset: 'BTC' } },
    });
    expect(String(usdtRepair.balance)).toBe(String(usdtAfter.balance));
    expect(String(usdtRepair.reserved)).toBe(String(usdtAfter.reserved));
    expect(String(btcRepair.available)).toBe(String(btcAfter.available));

    const conversion = await prisma.conversion.findUniqueOrThrow({ where: { id: conversionId } });
    expect(conversion.status).toBe('COMPLETED');
    expect(await prisma.processedMessage.count({ where: { eventId: eventPayload.eventId } })).toBe(
      1,
    );
  });

  it('creates a missing target wallet on SUCCESS settle', async () => {
    exchange.setMode('SUCCESS');
    exchange.clearMemoizedResults();

    // Ensure only USDT exists for a fresh user
    const lonelyUser = `exec-lonely-${randomUUID()}`;
    const usdt = WalletAccount.open(
      randomUUID(),
      UserId.of(lonelyUser),
      USDT,
      Money.of('50', USDT),
    );
    await prisma.walletAccount.create({
      data: {
        id: usdt.id,
        userId: lonelyUser,
        asset: 'USDT',
        balance: '50',
        available: '50',
        reserved: '0',
      },
    });

    const server = app.getHttpServer() as App;
    const quoteRes = await request(server).post('/quotes').send({
      userId: lonelyUser,
      sourceAsset: 'USDT',
      targetAsset: 'BTC',
      sourceAmount: '20',
    });
    const quoteId = (quoteRes.body as { quoteId: string }).quoteId;
    const acceptRes = await request(server)
      .post(`/quotes/${quoteId}/accept`)
      .set('Idempotency-Key', randomUUID())
      .send();
    expect(acceptRes.status).toBe(201);
    const conversionId = (acceptRes.body as AcceptQuoteSuccessBody).conversionId;
    const outbox = await prisma.outboxMessage.findFirstOrThrow({
      where: { aggregateId: conversionId },
    });

    expect(
      await prisma.walletAccount.findUnique({
        where: { userId_asset: { userId: lonelyUser, asset: 'BTC' } },
      }),
    ).toBeNull();

    await processExecution.execute(
      outbox.payload as unknown as ConversionExecutionRequestedPayload,
    );

    const btc = await prisma.walletAccount.findUniqueOrThrow({
      where: { userId_asset: { userId: lonelyUser, asset: 'BTC' } },
    });
    expect(Number(btc.available)).toBeGreaterThan(0);

    // cleanup lonely user
    await prisma.processedMessage.deleteMany({ where: { conversionId } });
    await prisma.outboxMessage.deleteMany({ where: { aggregateId: conversionId } });
    await prisma.idempotencyRecord.deleteMany({ where: { conversionId } });
    await prisma.conversion.deleteMany({ where: { userId: lonelyUser } });
    await prisma.quote.deleteMany({ where: { userId: lonelyUser } });
    await prisma.walletAccount.deleteMany({ where: { userId: lonelyUser } });
  });
});
