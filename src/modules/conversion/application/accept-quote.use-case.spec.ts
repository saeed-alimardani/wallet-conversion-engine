import { createHash } from 'crypto';
import { AcceptQuoteUseCase } from './accept-quote.use-case';
import { IdempotencyRepository } from '../domain/ports/idempotency-repository.port';
import { UnitOfWork } from '../domain/ports/unit-of-work.port';
import { Clock } from '../../shared/domain/ports/clock.port';
import { IdGenerator } from '../../shared/domain/ports/id-generator.port';

describe('AcceptQuoteUseCase idempotency wait', () => {
  const quoteId = 'quote-wait-1';
  const key = 'key-123';
  const hash = createHash('sha256').update(quoteId).digest('hex');
  const body = {
    conversionId: 'conv-1',
    quoteId,
    userId: 'user-1',
    status: 'FUNDS_RESERVED',
    sourceAsset: 'USDT',
    targetAsset: 'BTC',
    sourceAmount: '10',
    targetAmount: '0.000161',
    createdAt: '2026-08-01T10:00:05Z',
  };

  let previousWait: string | undefined;
  let previousPoll: string | undefined;

  beforeEach(() => {
    previousWait = process.env.IDEMPOTENCY_IN_PROGRESS_WAIT_MS;
    previousPoll = process.env.IDEMPOTENCY_IN_PROGRESS_POLL_MS;
    process.env.IDEMPOTENCY_IN_PROGRESS_WAIT_MS = '200';
    process.env.IDEMPOTENCY_IN_PROGRESS_POLL_MS = '10';
  });

  afterEach(() => {
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
  });

  function buildUseCase(deps: {
    uowResult: Awaited<ReturnType<AcceptQuoteUseCase['execute']>>;
    finds: Array<Awaited<ReturnType<IdempotencyRepository['find']>>>;
  }): AcceptQuoteUseCase {
    const uow: UnitOfWork = {
      execute: <T>(): Promise<T> => Promise.resolve(deps.uowResult as T),
    };

    let findCalls = 0;
    const idempotency: IdempotencyRepository = {
      find: jest.fn(() => {
        const next = deps.finds[findCalls] ?? deps.finds[deps.finds.length - 1];
        findCalls += 1;
        return Promise.resolve(next);
      }),
      tryBegin: jest.fn(),
      complete: jest.fn(),
      deleteExpired: jest.fn().mockResolvedValue(0),
    };

    const clock: Clock = { now: () => new Date('2026-08-01T10:00:00Z') };
    const ids: IdGenerator = { generate: () => 'id-1' };

    return new AcceptQuoteUseCase(uow, idempotency, clock, ids);
  }

  it('waits for an in-progress claim and replays the completed response', async () => {
    const useCase = buildUseCase({
      uowResult: {
        kind: 'error',
        statusCode: 409,
        errorCode: 'IDEMPOTENCY_IN_PROGRESS',
        message: 'in progress',
      },
      finds: [
        { kind: 'in-progress', requestHash: hash },
        {
          kind: 'completed',
          requestHash: hash,
          responseStatus: 201,
          responseBody: body,
          conversionId: 'conv-1',
        },
      ],
    });

    const result = await useCase.execute({ quoteId, idempotencyKey: key });
    expect(result).toEqual({
      kind: 'replay',
      statusCode: 201,
      body,
    });
  });

  it('returns IDEMPOTENCY_IN_PROGRESS when the claim never completes', async () => {
    const useCase = buildUseCase({
      uowResult: {
        kind: 'error',
        statusCode: 409,
        errorCode: 'IDEMPOTENCY_IN_PROGRESS',
        message: 'in progress',
      },
      finds: [{ kind: 'in-progress', requestHash: hash }],
    });

    const result = await useCase.execute({ quoteId, idempotencyKey: key });
    expect(result).toMatchObject({
      kind: 'error',
      errorCode: 'IDEMPOTENCY_IN_PROGRESS',
    });
  });
});
