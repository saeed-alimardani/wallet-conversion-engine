import { MetricsService } from '../../shared/infrastructure/metrics/metrics.service';
import { BTC, USDT } from '../../shared/domain/asset';
import { Money } from '../../shared/domain/money';
import { UserId } from '../../shared/domain/user-id';
import { QuoteId } from '../../pricing/domain/quote-id';
import { Conversion } from '../domain/conversion';
import { ConversionId } from '../domain/conversion-id';
import { ConversionExecutionRequestedPayload } from '../domain/outbox-message';
import { ConversionRepository } from '../domain/ports/conversion-repository.port';
import { ProcessedMessageRepository } from '../domain/ports/processed-message-repository.port';
import { UnitOfWork, UnitOfWorkContext } from '../domain/ports/unit-of-work.port';
import { ProcessConversionExecutionUseCase } from './process-conversion-execution.use-case';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSION_ID = '22222222-2222-4222-8222-222222222222';
const CREATED_AT = new Date('2026-08-06T00:00:00.000Z');

describe('ProcessConversionExecutionUseCase telemetry', () => {
  it('classifies a lost processed-message claim as a replay only', async () => {
    const conversion = executionRequestedConversion();
    const { useCase, metrics, exchange } = setup(conversion, {
      tryRecord: jest.fn().mockResolvedValue(false),
    });

    await expect(useCase.execute(payload())).resolves.toBeUndefined();

    expect(exchange.execute).toHaveBeenCalledTimes(1);
    expect(metrics.executionRetryTotal.inc).toHaveBeenCalledTimes(1);
    expect(metrics.eventProcessingDurationSeconds.observe).toHaveBeenCalledWith(
      { outcome: 'replay' },
      expect.any(Number),
    );
    expect(metrics.conversionCompletedTotal.inc).not.toHaveBeenCalled();
    expect(metrics.conversionFailedTotal.inc).not.toHaveBeenCalled();
  });

  it('propagates conflicting execution outcomes without terminal success metrics', async () => {
    const outer = executionRequestedConversion();
    const staleFailed = executionRequestedConversion();
    staleFailed.applyExecutionResult('FAILURE', new Date('2026-08-06T00:00:01.000Z'), 'rejected');
    const { useCase, metrics } = setup(outer, {
      tryRecord: jest.fn().mockResolvedValue(true),
      findById: jest.fn().mockResolvedValue(staleFailed),
    });

    await expect(useCase.execute(payload())).rejects.toThrow(
      /Conflicting execution result SUCCESS/,
    );

    expect(metrics.eventProcessingDurationSeconds.observe).toHaveBeenCalledWith(
      { outcome: 'error' },
      expect.any(Number),
    );
    expect(metrics.conversionCompletedTotal.inc).not.toHaveBeenCalled();
    expect(metrics.conversionFailedTotal.inc).not.toHaveBeenCalled();
  });
});

function setup(
  outer: Conversion,
  overrides: {
    tryRecord: jest.Mock;
    findById?: jest.Mock;
  },
): {
  useCase: ProcessConversionExecutionUseCase;
  metrics: {
    executionRetryTotal: { inc: jest.Mock };
    eventProcessingDurationSeconds: { observe: jest.Mock };
    conversionCompletedTotal: { inc: jest.Mock };
    conversionFailedTotal: { inc: jest.Mock };
  };
  exchange: { execute: jest.Mock };
} {
  const processedMessages = {
    exists: jest.fn().mockResolvedValue(false),
  } as unknown as ProcessedMessageRepository;
  const conversions = {
    markExecutionRequestedIfFundsReserved: jest.fn().mockResolvedValue(outer),
  } as unknown as ConversionRepository;
  const exchange = {
    execute: jest.fn().mockResolvedValue({ outcome: 'SUCCESS' }),
  };
  const context = {
    processedMessages: { tryRecord: overrides.tryRecord },
    conversions: {
      findById: overrides.findById ?? jest.fn(),
      save: jest.fn(),
    },
    wallets: {},
  } as unknown as UnitOfWorkContext;
  const uow: UnitOfWork = {
    execute: <T>(work: (ctx: UnitOfWorkContext) => Promise<T>): Promise<T> => work(context),
  };
  const metrics = {
    executionRetryTotal: { inc: jest.fn() },
    eventProcessingDurationSeconds: { observe: jest.fn() },
    conversionCompletedTotal: { inc: jest.fn() },
    conversionFailedTotal: { inc: jest.fn() },
  };

  return {
    useCase: new ProcessConversionExecutionUseCase(
      processedMessages,
      conversions,
      exchange,
      uow,
      { now: () => new Date('2026-08-06T00:00:02.000Z') },
      metrics as unknown as MetricsService,
    ),
    metrics,
    exchange,
  };
}

function executionRequestedConversion(): Conversion {
  const conversion = Conversion.create({
    id: ConversionId.of(CONVERSION_ID),
    quoteId: QuoteId.of('33333333-3333-4333-8333-333333333333'),
    userId: UserId.of('user-1'),
    sourceAmount: Money.of('10', USDT),
    targetAmount: Money.of('0.0005', BTC),
    createdAt: CREATED_AT,
  });
  conversion.markFundsReserved();
  conversion.bindExecutionEvent(EVENT_ID);
  conversion.markExecutionRequested(EVENT_ID);
  return conversion;
}

function payload(): ConversionExecutionRequestedPayload {
  return {
    eventId: EVENT_ID,
    eventType: 'ConversionExecutionRequested',
    conversionId: CONVERSION_ID,
    userId: 'user-1',
    sourceAsset: 'USDT',
    targetAsset: 'BTC',
    sourceAmount: '10',
    targetAmount: '0.0005',
    occurredAt: CREATED_AT.toISOString(),
  };
}
