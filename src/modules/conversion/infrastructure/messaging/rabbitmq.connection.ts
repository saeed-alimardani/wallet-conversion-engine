import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import amqp, { ChannelModel, ConfirmChannel, ConsumeMessage, Options } from 'amqplib';
import {
  CONVERSION_EXCHANGE_NAME,
  CONVERSION_EXECUTION_DEAD_LETTER_QUEUE,
  CONVERSION_EXECUTION_DEAD_LETTER_ROUTING_KEY,
  CONVERSION_EXECUTION_ROUTING_KEY,
} from './rabbitmq.constants';

type AmqpConnection = ChannelModel;
type MessageHandler = (msg: ConsumeMessage) => Promise<void>;

/**
 * Shared confirm-channel connection for the outbox publisher and execution consumer.
 * Topology and registered consumers are restored whenever the broker connection recovers.
 */
@Injectable()
export class RabbitMqConnection implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMqConnection.name);
  private connection: AmqpConnection | null = null;
  private channel: ConfirmChannel | null = null;
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private readonly consumers = new Map<string, MessageHandler>();
  private readonly activeConsumers = new Set<string>();
  private readonly enabled: boolean;
  private readonly connectMaxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly publishConfirmTimeoutMs: number;
  private readonly consumerMaxRetries: number;

  constructor(private readonly config: ConfigService) {
    this.enabled = config.get<string>('MESSAGING_ENABLED', 'true') !== 'false';
    this.connectMaxAttempts = this.positiveInteger('RABBITMQ_CONNECT_MAX_ATTEMPTS', 5);
    this.retryBaseDelayMs = this.positiveInteger('RABBITMQ_RETRY_BASE_DELAY_MS', 250);
    this.retryMaxDelayMs = this.positiveInteger('RABBITMQ_RETRY_MAX_DELAY_MS', 5000);
    this.publishConfirmTimeoutMs = this.positiveInteger(
      'RABBITMQ_PUBLISH_CONFIRM_TIMEOUT_MS',
      5000,
    );
    this.consumerMaxRetries = this.nonNegativeInteger('RABBITMQ_CONSUMER_MAX_RETRIES', 3);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn('RabbitMQ messaging disabled (MESSAGING_ENABLED=false)');
      return;
    }
    await this.connectWithRetry();
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.close();
  }

  async getChannel(): Promise<ConfirmChannel> {
    if (!this.enabled) {
      throw new Error('RabbitMQ messaging is disabled');
    }
    if (!this.channel) {
      await this.connectWithRetry();
    }
    if (!this.channel) {
      throw new Error('RabbitMQ channel is not available');
    }
    return this.channel;
  }

  async publish(routingKey: string, payload: unknown): Promise<void> {
    const messageId =
      typeof payload === 'object' &&
      payload !== null &&
      'eventId' in payload &&
      typeof payload.eventId === 'string'
        ? (payload as { eventId: string }).eventId
        : undefined;
    await this.publishBuffer(routingKey, Buffer.from(JSON.stringify(payload)), {
      contentType: 'application/json',
      deliveryMode: 2,
      messageId,
    });
  }

  async consume(queue: string, handler: MessageHandler): Promise<void> {
    if (this.consumers.has(queue)) {
      throw new Error(`RabbitMQ consumer already registered for queue ${queue}`);
    }
    this.consumers.set(queue, handler);
    const channel = await this.getChannel();
    await this.startConsumer(channel, queue, handler);
  }

  private async connectWithRetry(): Promise<void> {
    if (this.channel) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.tryConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async tryConnect(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.connectMaxAttempts; attempt += 1) {
      if (this.shuttingDown) {
        throw new Error('RabbitMQ connection is shutting down');
      }
      try {
        await this.connectOnce();
        return;
      } catch (error: unknown) {
        lastError = error;
        this.logger.error({
          msg: 'rabbitmq_connect_attempt_failed',
          attempt,
          maxAttempts: this.connectMaxAttempts,
          errorCode: error instanceof Error ? error.name : 'Error',
          err: error instanceof Error ? error.message : String(error),
        });
        if (attempt < this.connectMaxAttempts) {
          await this.delay(this.retryDelay(attempt));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async connectOnce(): Promise<void> {
    const url = this.config.get<string>('RABBITMQ_URL');
    if (!url) {
      throw new Error('RABBITMQ_URL is required when messaging is enabled');
    }

    const connection = await amqp.connect(url);
    let channel: ConfirmChannel | null = null;
    try {
      channel = await connection.createConfirmChannel();
      await channel.assertExchange(CONVERSION_EXCHANGE_NAME, 'topic', { durable: true });
      await channel.assertQueue(CONVERSION_EXECUTION_ROUTING_KEY, { durable: true });
      await channel.bindQueue(
        CONVERSION_EXECUTION_ROUTING_KEY,
        CONVERSION_EXCHANGE_NAME,
        CONVERSION_EXECUTION_ROUTING_KEY,
      );
      await channel.assertQueue(CONVERSION_EXECUTION_DEAD_LETTER_QUEUE, { durable: true });
      await channel.bindQueue(
        CONVERSION_EXECUTION_DEAD_LETTER_QUEUE,
        CONVERSION_EXCHANGE_NAME,
        CONVERSION_EXECUTION_DEAD_LETTER_ROUTING_KEY,
      );
      await channel.prefetch(10);
    } catch (error: unknown) {
      await this.safeCloseChannel(channel);
      await this.safeCloseConnection(connection);
      throw error;
    }
    if (!channel) {
      throw new Error('RabbitMQ confirm channel was not created');
    }

    this.connection = connection;
    this.channel = channel;
    this.activeConsumers.clear();
    this.registerLifecycleHandlers(connection, channel);
    try {
      for (const [queue, handler] of this.consumers) {
        await this.startConsumer(channel, queue, handler);
      }
    } catch (error: unknown) {
      this.connection = null;
      this.channel = null;
      this.activeConsumers.clear();
      await this.safeCloseChannel(channel);
      await this.safeCloseConnection(connection);
      throw error;
    }

    this.logger.log({
      msg: 'rabbitmq_connected',
      exchange: CONVERSION_EXCHANGE_NAME,
      queue: CONVERSION_EXECUTION_ROUTING_KEY,
    });
  }

  private registerLifecycleHandlers(connection: AmqpConnection, channel: ConfirmChannel): void {
    connection.on('error', (error: Error) => {
      this.logger.error({ msg: 'rabbitmq_connection_error', err: error.message });
    });
    connection.on('close', () => {
      if (this.connection !== connection) {
        return;
      }
      this.logger.warn({ msg: 'rabbitmq_connection_closed' });
      this.connection = null;
      this.channel = null;
      this.activeConsumers.clear();
      this.scheduleReconnect();
    });
    channel.on('error', (error: Error) => {
      this.logger.error({ msg: 'rabbitmq_channel_error', err: error.message });
    });
    channel.on('close', () => {
      if (this.channel !== channel) {
        return;
      }
      this.logger.warn({ msg: 'rabbitmq_channel_closed' });
      this.channel = null;
      this.connection = null;
      this.activeConsumers.clear();
      void this.safeCloseConnection(connection);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(delayMs = this.retryBaseDelayMs): void {
    if (this.shuttingDown || this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectWithRetry().catch((error: unknown) => {
        this.logger.error({
          msg: 'rabbitmq_reconnect_exhausted',
          errorCode: error instanceof Error ? error.name : 'Error',
          err: error instanceof Error ? error.message : String(error),
        });
        this.scheduleReconnect(this.retryMaxDelayMs);
      });
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private async startConsumer(
    channel: ConfirmChannel,
    queue: string,
    handler: MessageHandler,
  ): Promise<void> {
    if (this.activeConsumers.has(queue)) {
      return;
    }
    await channel.consume(
      queue,
      (message) => {
        if (!message) {
          return;
        }
        void handler(message)
          .then(() => channel.ack(message))
          .catch((error: unknown) => this.handleConsumerFailure(channel, queue, message, error));
      },
      { noAck: false },
    );
    this.activeConsumers.add(queue);
  }

  private async handleConsumerFailure(
    channel: ConfirmChannel,
    queue: string,
    message: ConsumeMessage,
    error: unknown,
  ): Promise<void> {
    const retryCount = this.retryCount(message);
    this.logger.error({
      msg: 'rabbitmq_consumer_handler_failed',
      retryCount,
      maxRetries: this.consumerMaxRetries,
      errorCode: error instanceof Error ? error.name : 'Error',
      operationResult: 'failure',
      err: error instanceof Error ? error.message : String(error),
    });

    try {
      if (retryCount < this.consumerMaxRetries) {
        await this.publishBuffer(
          queue,
          message.content,
          this.copyPublishOptions(message, {
            ...this.messageHeaders(message),
            'x-retry-count': retryCount + 1,
          }),
          channel,
        );
        channel.ack(message);
        return;
      }

      await this.publishBuffer(
        CONVERSION_EXECUTION_DEAD_LETTER_ROUTING_KEY,
        message.content,
        this.copyPublishOptions(message, {
          ...this.messageHeaders(message),
          'x-retry-count': retryCount,
          'x-error-code': error instanceof Error ? error.name : 'Error',
          'x-original-routing-key': queue,
        }),
        channel,
      );
      channel.ack(message);
      this.logger.error({
        msg: 'rabbitmq_message_dead_lettered',
        retryCount,
        operationResult: 'failure',
      });
    } catch (publishError: unknown) {
      this.logger.error({
        msg: 'rabbitmq_retry_publish_failed',
        errorCode: publishError instanceof Error ? publishError.name : 'Error',
        err: publishError instanceof Error ? publishError.message : String(publishError),
      });
      try {
        channel.nack(message, false, true);
      } catch {
        // The broker will redeliver unacked messages after a channel reconnect.
      }
    }
  }

  private async publishBuffer(
    routingKey: string,
    body: Buffer,
    options: Options.Publish,
    channelOverride?: ConfirmChannel,
  ): Promise<void> {
    const channel = channelOverride ?? (await this.getChannel());
    const writable = channel.publish(CONVERSION_EXCHANGE_NAME, routingKey, body, options);
    const confirmation = this.withTimeout(
      channel.waitForConfirms(),
      this.publishConfirmTimeoutMs,
      `RabbitMQ publish confirmation timed out for routing key ${routingKey}`,
    );
    if (!writable) {
      await Promise.all([confirmation, this.waitForDrain(channel, routingKey)]);
      return;
    }
    await confirmation;
  }

  private copyPublishOptions(
    message: ConsumeMessage,
    headers: Record<string, unknown>,
  ): Options.Publish {
    const rawMessageId: unknown = message.properties.messageId as unknown;
    return {
      contentType: 'application/json',
      headers,
      deliveryMode: 2,
      ...(typeof rawMessageId === 'string' ? { messageId: rawMessageId } : {}),
    };
  }

  private retryCount(message: ConsumeMessage): number {
    const value = this.messageHeaders(message)['x-retry-count'];
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  private messageHeaders(message: ConsumeMessage): Record<string, unknown> {
    const value: unknown = message.properties.headers;
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  }

  private async waitForDrain(channel: ConfirmChannel, routingKey: string): Promise<void> {
    await this.withTimeout(
      new Promise<void>((resolve, reject) => {
        const onDrain = (): void => {
          cleanup();
          resolve();
        };
        const onClose = (): void => {
          cleanup();
          reject(new Error(`RabbitMQ channel closed while publishing ${routingKey}`));
        };
        const onError = (error: Error): void => {
          cleanup();
          reject(error);
        };
        const cleanup = (): void => {
          channel.off('drain', onDrain);
          channel.off('close', onClose);
          channel.off('error', onError);
        };
        channel.once('drain', onDrain);
        channel.once('close', onClose);
        channel.once('error', onError);
      }),
      this.publishConfirmTimeoutMs,
      `RabbitMQ publish backpressure timed out for routing key ${routingKey}`,
    );
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(message)), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private retryDelay(attempt: number): number {
    return Math.min(this.retryBaseDelayMs * 2 ** (attempt - 1), this.retryMaxDelayMs);
  }

  private positiveInteger(key: string, fallback: number): number {
    const value = Number(this.config.get<string>(key, String(fallback)));
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${key} must be a positive integer`);
    }
    return value;
  }

  private nonNegativeInteger(key: string, fallback: number): number {
    const value = Number(this.config.get<string>(key, String(fallback)));
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${key} must be a non-negative integer`);
    }
    return value;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async close(): Promise<void> {
    const channel = this.channel;
    const connection = this.connection;
    this.channel = null;
    this.connection = null;
    this.activeConsumers.clear();
    await this.safeCloseChannel(channel);
    await this.safeCloseConnection(connection);
  }

  private async safeCloseChannel(channel: ConfirmChannel | null): Promise<void> {
    try {
      await channel?.close();
    } catch {
      // Ignore close races.
    }
  }

  private async safeCloseConnection(connection: AmqpConnection | null): Promise<void> {
    try {
      await connection?.close();
    } catch {
      // Ignore close races.
    }
  }
}
