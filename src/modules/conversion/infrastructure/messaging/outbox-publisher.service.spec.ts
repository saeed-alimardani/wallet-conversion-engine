import { ConfigService } from '@nestjs/config';
import { Clock } from '../../../shared/domain/ports/clock.port';
import { MetricsService } from '../../../shared/infrastructure/metrics/metrics.service';
import { OutboxMessage } from '../../domain/outbox-message';
import { OutboxRepository } from '../../domain/ports/outbox-repository.port';
import { OutboxPublisherService } from './outbox-publisher.service';
import { RabbitMqConnection } from './rabbitmq.connection';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function message(id: string): OutboxMessage {
  return OutboxMessage.createConversionExecutionRequested({
    id,
    createdAt: new Date('2026-08-06T00:00:00.000Z'),
    payload: {
      eventId: id,
      eventType: 'ConversionExecutionRequested',
      conversionId: '11111111-1111-4111-8111-111111111111',
      userId: 'user-1',
      sourceAsset: 'USDT',
      targetAsset: 'BTC',
      sourceAmount: '10',
      targetAmount: '0.0005',
      occurredAt: '2026-08-06T00:00:00.000Z',
    },
  });
}

describe('OutboxPublisherService', () => {
  function setup(messages: OutboxMessage[]): {
    publisher: OutboxPublisherService;
    publish: jest.Mock;
    markPublished: jest.Mock;
    failureIncrement: jest.Mock;
  } {
    const publish = jest.fn().mockResolvedValue(undefined);
    const rabbit = {
      isEnabled: true,
      publish,
    } as unknown as RabbitMqConnection;
    const markPublished = jest.fn().mockResolvedValue(undefined);
    const outbox: OutboxRepository = {
      enqueue: jest.fn(),
      findUnpublished: jest.fn().mockResolvedValue(messages),
      markPublished,
      countUnpublished: jest.fn().mockResolvedValue(messages.length),
    };
    const clock: Clock = { now: () => new Date('2026-08-06T00:00:01.000Z') };
    const failureIncrement = jest.fn();
    const metrics = {
      setOutboxPendingCountProvider: jest.fn(),
      outboxPublishFailureTotal: { inc: failureIncrement },
    } as unknown as MetricsService;
    const config = {
      get: (_key: string, defaultValue?: string) => defaultValue,
    } as unknown as ConfigService;
    return {
      publisher: new OutboxPublisherService(rabbit, config, outbox, clock, metrics),
      publish,
      markPublished,
      failureIncrement,
    };
  }

  it('marks an outbox row only after confirmed publish resolves', async () => {
    const confirmation = deferred();
    const { publisher, publish, markPublished } = setup([message('event-1')]);
    publish.mockReturnValue(confirmation.promise);

    const batch = publisher.publishBatch();
    await Promise.resolve();
    expect(markPublished).not.toHaveBeenCalled();

    confirmation.resolve();
    await expect(batch).resolves.toBe(1);
    expect(markPublished).toHaveBeenCalledWith('event-1', new Date('2026-08-06T00:00:01.000Z'));
  });

  it('leaves the row unpublished and stops the batch after publish failure', async () => {
    const { publisher, publish, markPublished, failureIncrement } = setup([
      message('event-1'),
      message('event-2'),
    ]);
    publish.mockRejectedValueOnce(new Error('broker nack'));

    await expect(publisher.publishBatch()).resolves.toBe(0);
    expect(markPublished).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(failureIncrement).toHaveBeenCalledTimes(1);
  });
});
