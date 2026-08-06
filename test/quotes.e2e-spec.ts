import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/modules/shared/infrastructure/prisma/prisma.service';
import { QuoteResponse } from '../src/modules/pricing/presentation/quotes.controller';

/**
 * Requires `docker compose up -d postgres`. Covers POST /quotes happy path and
 * validation against the deterministic fake pricing provider.
 */
describe('Quotes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const createdQuoteIds: string[] = [];

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
  });

  afterAll(async () => {
    if (createdQuoteIds.length > 0) {
      await prisma.quote.deleteMany({ where: { id: { in: createdQuoteIds } } });
    }
    await app.close();
  });

  it('POST /quotes returns an ACTIVE quote matching the spec example amounts', async () => {
    const server = app.getHttpServer() as App;
    const response = await request(server).post('/quotes').send({
      userId: 'user-123',
      sourceAsset: 'USDT',
      targetAsset: 'BTC',
      sourceAmount: '100',
    });

    expect(response.status).toBe(201);
    const body = response.body as QuoteResponse;
    expect(body).toMatchObject({
      sourceAsset: 'USDT',
      targetAsset: 'BTC',
      sourceAmount: '100',
      targetAmount: '0.00161',
      rate: '0.0000161',
      status: 'ACTIVE',
    });
    expect(typeof body.quoteId).toBe('string');
    expect(typeof body.expiresAt).toBe('string');

    const createdAtMs = Date.now();
    const row = await prisma.quote.findUnique({ where: { id: body.quoteId } });
    expect(row).not.toBeNull();
    createdQuoteIds.push(body.quoteId);

    const ttlMs = row!.expiresAt.getTime() - row!.createdAt.getTime();
    expect(ttlMs).toBe(20_000);
    expect(row!.expiresAt.getTime()).toBeGreaterThan(createdAtMs - 5_000);
  });

  it('POST /quotes rejects an unknown asset', async () => {
    const server = app.getHttpServer() as App;
    const response = await request(server).post('/quotes').send({
      userId: 'user-123',
      sourceAsset: 'USDT',
      targetAsset: 'DOGE',
      sourceAmount: '100',
    });

    expect(response.status).toBe(400);
    const body = response.body as { errorCode?: string; message?: unknown };
    expect(body.errorCode ?? body.message).toBeTruthy();
  });

  it('POST /quotes rejects a non-decimal sourceAmount', async () => {
    const server = app.getHttpServer() as App;
    const response = await request(server).post('/quotes').send({
      userId: 'user-123',
      sourceAsset: 'USDT',
      targetAsset: 'BTC',
      sourceAmount: 100,
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
    });
  });

  it('POST /quotes rejects oversized input and unknown properties', async () => {
    const server = app.getHttpServer() as App;
    const oversized = await request(server)
      .post('/quotes')
      .send({
        userId: 'u'.repeat(129),
        sourceAsset: 'USDT',
        targetAsset: 'BTC',
        sourceAmount: '1',
      });
    expect(oversized.status).toBe(400);
    expect(oversized.body).toMatchObject({ errorCode: 'VALIDATION_ERROR' });

    const unknownProperty = await request(server).post('/quotes').send({
      userId: 'user-123',
      sourceAsset: 'USDT',
      targetAsset: 'BTC',
      sourceAmount: '1',
      admin: true,
    });
    expect(unknownProperty.status).toBe(400);
    expect(unknownProperty.body).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('echoes safe correlation ids and replaces oversized values', async () => {
    const server = app.getHttpServer() as App;
    const missing = await request(server).get('/route-that-does-not-exist').set({
      'X-Correlation-Id': 'client-trace-123',
    });
    expect(missing.status).toBe(404);
    expect(missing.headers['x-correlation-id']).toBe('client-trace-123');
    expect(missing.body).toMatchObject({
      statusCode: 404,
      errorCode: 'NOT_FOUND',
      correlationId: 'client-trace-123',
    });

    const replaced = await request(server)
      .get('/route-that-does-not-exist')
      .set({
        'X-Correlation-Id': 'x'.repeat(129),
      });
    expect(replaced.status).toBe(404);
    expect(replaced.headers['x-correlation-id']).not.toBe('x'.repeat(129));
    expect(replaced.headers['x-correlation-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('POST /quotes rejects zero sourceAmount', async () => {
    const server = app.getHttpServer() as App;
    const response = await request(server).post('/quotes').send({
      userId: 'user-123',
      sourceAsset: 'USDT',
      targetAsset: 'BTC',
      sourceAmount: '0',
    });
    expect(response.status).toBe(400);
  });

  it('POST /quotes rejects same source and target asset', async () => {
    const server = app.getHttpServer() as App;
    const response = await request(server).post('/quotes').send({
      userId: 'user-123',
      sourceAsset: 'USDT',
      targetAsset: 'USDT',
      sourceAmount: '10',
    });
    expect(response.status).toBe(400);
  });

  it('POST /quotes supports BTC → USDT with the deterministic reverse rate', async () => {
    const server = app.getHttpServer() as App;
    const response = await request(server).post('/quotes').send({
      userId: 'user-123',
      sourceAsset: 'BTC',
      targetAsset: 'USDT',
      sourceAmount: '0.00161',
    });
    expect(response.status).toBe(201);
    const body = response.body as QuoteResponse;
    createdQuoteIds.push(body.quoteId);
    expect(body.sourceAsset).toBe('BTC');
    expect(body.targetAsset).toBe('USDT');
    expect(body.rate).toBe('62111.801242236');
    expect(Number(body.targetAmount)).toBeGreaterThan(0);
  });
});
