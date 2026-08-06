import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { GetMessage } from 'amqplib';
import {
  CONVERSION_EXECUTION_DEAD_LETTER_QUEUE,
  CONVERSION_EXECUTION_ROUTING_KEY,
} from '../src/modules/conversion/infrastructure/messaging/rabbitmq.constants';
import { RabbitMqConnection } from '../src/modules/conversion/infrastructure/messaging/rabbitmq.connection';

function config(): ConfigService {
  const values: Record<string, string> = {
    MESSAGING_ENABLED: 'true',
    RABBITMQ_URL: process.env.RABBITMQ_URL ?? 'amqp://wallet:wallet@localhost:5672',
    RABBITMQ_CONNECT_MAX_ATTEMPTS: '3',
    RABBITMQ_RETRY_BASE_DELAY_MS: '10',
    RABBITMQ_RETRY_MAX_DELAY_MS: '25',
    RABBITMQ_PUBLISH_CONFIRM_TIMEOUT_MS: '2000',
    RABBITMQ_CONSUMER_MAX_RETRIES: '1',
  };
  return {
    get: (key: string, defaultValue?: string) => values[key] ?? defaultValue,
  } as unknown as ConfigService;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function getDeadLetter(rabbit: RabbitMqConnection, eventId: string): Promise<GetMessage> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const channel = await rabbit.getChannel();
    const delivery = await channel.get(CONVERSION_EXECUTION_DEAD_LETTER_QUEUE, { noAck: false });
    if (delivery) {
      const parsed = JSON.parse(delivery.content.toString('utf8')) as { eventId?: string };
      if (parsed.eventId === eventId) {
        return delivery;
      }
      channel.nack(delivery, false, true);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for dead-letter event ${eventId}`);
}

describe('RabbitMQ reliability (integration)', () => {
  jest.setTimeout(15000);

  let rabbit: RabbitMqConnection;

  beforeEach(async () => {
    rabbit = new RabbitMqConnection(config());
    await rabbit.onModuleInit();
    const channel = await rabbit.getChannel();
    await channel.purgeQueue(CONVERSION_EXECUTION_ROUTING_KEY);
    await channel.purgeQueue(CONVERSION_EXECUTION_DEAD_LETTER_QUEUE);
  });

  afterEach(async () => {
    await rabbit.onModuleDestroy();
  });

  it('delivers a broker-confirmed persistent publication', async () => {
    const eventId = randomUUID();
    const received = deferred<string>();
    await rabbit.consume(CONVERSION_EXECUTION_ROUTING_KEY, (message) => {
      const payload = JSON.parse(message.content.toString('utf8')) as { eventId: string };
      received.resolve(payload.eventId);
      return Promise.resolve();
    });

    await rabbit.publish(CONVERSION_EXECUTION_ROUTING_KEY, { eventId });

    await expect(received.promise).resolves.toBe(eventId);
  });

  it('dead-letters a poison message after the configured retry limit', async () => {
    const eventId = randomUUID();
    await rabbit.consume(CONVERSION_EXECUTION_ROUTING_KEY, () =>
      Promise.reject(new Error('poison message')),
    );

    await rabbit.publish(CONVERSION_EXECUTION_ROUTING_KEY, { eventId });
    const deadLetter = await getDeadLetter(rabbit, eventId);
    const rawHeaders: unknown = deadLetter.properties.headers;
    const headers =
      typeof rawHeaders === 'object' && rawHeaders !== null
        ? (rawHeaders as Record<string, unknown>)
        : {};

    expect(headers['x-retry-count']).toBe(1);
    expect(headers['x-original-routing-key']).toBe(CONVERSION_EXECUTION_ROUTING_KEY);
    const channel = await rabbit.getChannel();
    await channel.waitForConfirms();
    await new Promise((resolve) => setImmediate(resolve));
    channel.ack(deadLetter);
  });

  it('restores a registered consumer after the channel reconnects', async () => {
    const eventId = randomUUID();
    const received = deferred<string>();
    await rabbit.consume(CONVERSION_EXECUTION_ROUTING_KEY, (message) => {
      const payload = JSON.parse(message.content.toString('utf8')) as { eventId: string };
      received.resolve(payload.eventId);
      return Promise.resolve();
    });

    await (await rabbit.getChannel()).close();
    await rabbit.publish(CONVERSION_EXECUTION_ROUTING_KEY, { eventId });

    await expect(received.promise).resolves.toBe(eventId);
  });
});
