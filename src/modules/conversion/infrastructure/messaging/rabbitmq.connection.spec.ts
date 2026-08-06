import { EventEmitter } from 'events';
import { ConfigService } from '@nestjs/config';
import amqp, { ChannelModel, ConfirmChannel, ConsumeMessage, Options } from 'amqplib';
import {
  CONVERSION_EXECUTION_DEAD_LETTER_ROUTING_KEY,
  CONVERSION_EXECUTION_ROUTING_KEY,
} from './rabbitmq.constants';
import { RabbitMqConnection } from './rabbitmq.connection';

jest.mock('amqplib', () => ({
  __esModule: true,
  default: { connect: jest.fn() },
}));

type ChannelDouble = ConfirmChannel & {
  testMocks: {
    publish: jest.Mock;
    waitForConfirms: jest.Mock;
    consume: jest.Mock;
    ack: jest.Mock;
    nack: jest.Mock;
    consumer: ((incoming: ConsumeMessage | null) => void) | null;
    published: Array<{
      routingKey: string;
      headers: Record<string, unknown>;
      messageId?: string;
      correlationId?: string;
    }>;
  };
};

type ConnectionDouble = ChannelModel & {
  createConfirmChannel: jest.Mock;
};

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function channelDouble(): ChannelDouble {
  const channel = new EventEmitter() as ChannelDouble;
  const published: ChannelDouble['testMocks']['published'] = [];
  const testMocks = {
    publish: jest.fn(
      (_exchange: string, routingKey: string, _body: Buffer, options?: Options.Publish) => {
        const publishOptions = options ?? {};
        const headers =
          typeof publishOptions.headers === 'object' && publishOptions.headers !== null
            ? (publishOptions.headers as Record<string, unknown>)
            : {};
        published.push({
          routingKey,
          headers,
          ...(typeof publishOptions.messageId === 'string'
            ? { messageId: publishOptions.messageId }
            : {}),
          ...(typeof publishOptions.correlationId === 'string'
            ? { correlationId: publishOptions.correlationId }
            : {}),
        });
        return true;
      },
    ),
    waitForConfirms: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn(),
    ack: jest.fn(),
    nack: jest.fn(),
    consumer: null as ((incoming: ConsumeMessage | null) => void) | null,
    published,
  };
  channel.testMocks = testMocks;
  channel.assertExchange = jest.fn().mockResolvedValue({ exchange: 'conversion.events' });
  channel.assertQueue = jest
    .fn()
    .mockImplementation((queue: string) =>
      Promise.resolve({ queue, messageCount: 0, consumerCount: 0 }),
    );
  channel.bindQueue = jest.fn().mockResolvedValue({});
  channel.prefetch = jest.fn().mockResolvedValue({});
  channel.publish = testMocks.publish;
  channel.waitForConfirms = testMocks.waitForConfirms;
  channel.consume = testMocks.consume.mockImplementation(
    (_queue: string, consumer: (incoming: ConsumeMessage | null) => void) => {
      testMocks.consumer = consumer;
      return Promise.resolve({ consumerTag: 'consumer-1' });
    },
  );
  channel.ack = testMocks.ack;
  channel.nack = testMocks.nack;
  channel.close = jest.fn().mockResolvedValue(undefined);
  return channel;
}

function connectionDouble(channel: ChannelDouble): ConnectionDouble {
  const connection = new EventEmitter() as ConnectionDouble;
  connection.createConfirmChannel = jest.fn().mockResolvedValue(channel);
  connection.close = jest.fn().mockResolvedValue(undefined);
  return connection;
}

function config(overrides: Record<string, string> = {}): ConfigService {
  const values: Record<string, string> = {
    MESSAGING_ENABLED: 'true',
    RABBITMQ_URL: 'amqp://test',
    RABBITMQ_CONNECT_MAX_ATTEMPTS: '3',
    RABBITMQ_RETRY_BASE_DELAY_MS: '1',
    RABBITMQ_RETRY_MAX_DELAY_MS: '2',
    RABBITMQ_PUBLISH_CONFIRM_TIMEOUT_MS: '100',
    RABBITMQ_CONSUMER_MAX_RETRIES: '1',
    ...overrides,
  };
  return {
    get: (key: string, defaultValue?: string) => values[key] ?? defaultValue,
  } as unknown as ConfigService;
}

function message(retryCount = 0): ConsumeMessage {
  return {
    content: Buffer.from('{"eventId":"event-1"}'),
    fields: {
      consumerTag: 'consumer-1',
      deliveryTag: 1,
      redelivered: retryCount > 0,
      exchange: 'conversion.events',
      routingKey: CONVERSION_EXECUTION_ROUTING_KEY,
    },
    properties: {
      contentType: 'application/json',
      contentEncoding: undefined,
      headers: { 'x-retry-count': retryCount },
      deliveryMode: 2,
      priority: undefined,
      correlationId: 'event-1',
      replyTo: undefined,
      expiration: undefined,
      messageId: 'event-1',
      timestamp: undefined,
      type: undefined,
      userId: undefined,
      appId: undefined,
      clusterId: undefined,
    },
  };
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  assertion();
}

describe('RabbitMqConnection', () => {
  const connect = amqp.connect as jest.MockedFunction<typeof amqp.connect>;

  beforeEach(() => {
    connect.mockReset();
  });

  it('does not resolve publish before the broker confirms it', async () => {
    const confirmation = deferred();
    const channel = channelDouble();
    channel.testMocks.waitForConfirms.mockReturnValue(confirmation.promise);
    connect.mockResolvedValue(connectionDouble(channel));
    const rabbit = new RabbitMqConnection(config());
    await rabbit.onModuleInit();

    let settled = false;
    const publishing = rabbit
      .publish(CONVERSION_EXECUTION_ROUTING_KEY, { eventId: 'event-1' })
      .then(() => {
        settled = true;
      });
    await Promise.resolve();

    expect(channel.testMocks.waitForConfirms).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    confirmation.resolve();
    await publishing;
    expect(settled).toBe(true);
    expect(channel.testMocks.published[0]).toMatchObject({
      messageId: 'event-1',
      correlationId: 'event-1',
    });
    await rabbit.onModuleDestroy();
  });

  it('waits for channel drain when publish applies backpressure', async () => {
    const channel = channelDouble();
    channel.testMocks.publish.mockReturnValue(false);
    connect.mockResolvedValue(connectionDouble(channel));
    const rabbit = new RabbitMqConnection(config());
    await rabbit.onModuleInit();

    let settled = false;
    const publishing = rabbit
      .publish(CONVERSION_EXECUTION_ROUTING_KEY, { eventId: 'event-1' })
      .then(() => {
        settled = true;
      });
    await Promise.resolve();
    expect(settled).toBe(false);

    channel.emit('drain');
    await publishing;
    expect(settled).toBe(true);
    await rabbit.onModuleDestroy();
  });

  it('rejects a publication when the broker negatively acknowledges it', async () => {
    const channel = channelDouble();
    channel.testMocks.waitForConfirms.mockRejectedValue(new Error('broker nack'));
    connect.mockResolvedValue(connectionDouble(channel));
    const rabbit = new RabbitMqConnection(config());
    await rabbit.onModuleInit();

    await expect(
      rabbit.publish(CONVERSION_EXECUTION_ROUTING_KEY, { eventId: 'event-1' }),
    ).rejects.toThrow('broker nack');
    await rabbit.onModuleDestroy();
  });

  it('retries connection setup with bounded backoff', async () => {
    const channel = channelDouble();
    connect
      .mockRejectedValueOnce(new Error('broker unavailable'))
      .mockRejectedValueOnce(new Error('broker unavailable'))
      .mockResolvedValue(connectionDouble(channel));

    const rabbit = new RabbitMqConnection(config());
    await rabbit.onModuleInit();
    expect(connect).toHaveBeenCalledTimes(3);
    await rabbit.onModuleDestroy();
  });

  it('restores registered consumers after reconnect', async () => {
    const firstChannel = channelDouble();
    const secondChannel = channelDouble();
    const firstConnection = connectionDouble(firstChannel);
    const secondConnection = connectionDouble(secondChannel);
    connect.mockResolvedValueOnce(firstConnection).mockResolvedValueOnce(secondConnection);
    const rabbit = new RabbitMqConnection(config());
    await rabbit.onModuleInit();
    await rabbit.consume(CONVERSION_EXECUTION_ROUTING_KEY, jest.fn().mockResolvedValue(undefined));

    firstConnection.emit('close');
    await rabbit.getChannel();

    expect(secondChannel.testMocks.consume).toHaveBeenCalledTimes(1);
    await rabbit.onModuleDestroy();
  });

  it('republishes transient failures once, then dead-letters the exhausted message', async () => {
    const channel = channelDouble();
    connect.mockResolvedValue(connectionDouble(channel));
    const rabbit = new RabbitMqConnection(config());
    await rabbit.onModuleInit();
    const handler = jest.fn().mockRejectedValue(new Error('handler failed'));
    await rabbit.consume(CONVERSION_EXECUTION_ROUTING_KEY, handler);
    const consumeCallback = channel.testMocks.consumer;
    expect(consumeCallback).not.toBeNull();
    if (!consumeCallback) {
      throw new Error('Consumer callback was not registered');
    }

    consumeCallback(message(0));
    await eventually(() => expect(channel.testMocks.ack).toHaveBeenCalledTimes(1));
    expect(channel.testMocks.published[0].routingKey).toBe(CONVERSION_EXECUTION_ROUTING_KEY);
    expect(channel.testMocks.published[0].headers['x-retry-count']).toBe(1);
    expect(channel.testMocks.published[0]).toMatchObject({
      messageId: 'event-1',
      correlationId: 'event-1',
    });

    consumeCallback(message(1));
    await eventually(() => expect(channel.testMocks.ack).toHaveBeenCalledTimes(2));
    expect(channel.testMocks.published[1].routingKey).toBe(
      CONVERSION_EXECUTION_DEAD_LETTER_ROUTING_KEY,
    );
    expect(channel.testMocks.published[1].headers['x-retry-count']).toBe(1);
    expect(channel.testMocks.published[1]).toMatchObject({
      messageId: 'event-1',
      correlationId: 'event-1',
    });
    expect(channel.testMocks.nack).not.toHaveBeenCalled();
    await rabbit.onModuleDestroy();
  });
});
