import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import amqp, { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import { CONVERSION_EXCHANGE_NAME, CONVERSION_EXECUTION_ROUTING_KEY } from './rabbitmq.constants';

type AmqpConnection = ChannelModel;

/**
 * Shared RabbitMQ connection for the outbox publisher and execution consumer.
 * Declares a durable topic exchange + queue binding on connect.
 */
@Injectable()
export class RabbitMqConnection implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMqConnection.name);
  private connection: AmqpConnection | null = null;
  private channel: Channel | null = null;
  private readonly enabled: boolean;

  constructor(private readonly config: ConfigService) {
    // Integration tests can disable the live consumer/publisher loops and still
    // exercise use cases directly; connection is skipped when messaging is off.
    this.enabled = config.get<string>('MESSAGING_ENABLED', 'true') !== 'false';
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn('RabbitMQ messaging disabled (MESSAGING_ENABLED=false)');
      return;
    }
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  async getChannel(): Promise<Channel> {
    if (!this.enabled) {
      throw new Error('RabbitMQ messaging is disabled');
    }
    if (!this.channel) {
      await this.connect();
    }
    if (!this.channel) {
      throw new Error('RabbitMQ channel is not available');
    }
    return this.channel;
  }

  async publish(routingKey: string, payload: unknown): Promise<void> {
    const channel = await this.getChannel();
    const body = Buffer.from(JSON.stringify(payload));
    const ok = channel.publish(CONVERSION_EXCHANGE_NAME, routingKey, body, {
      contentType: 'application/json',
      deliveryMode: 2, // persistent
      messageId:
        typeof payload === 'object' &&
        payload !== null &&
        'eventId' in payload &&
        typeof payload.eventId === 'string'
          ? (payload as { eventId: string }).eventId
          : undefined,
    });
    if (!ok) {
      throw new Error(`RabbitMQ publish buffer full for routing key ${routingKey}`);
    }
  }

  async consume(queue: string, handler: (msg: ConsumeMessage) => Promise<void>): Promise<void> {
    const channel = await this.getChannel();
    await channel.consume(
      queue,
      (msg) => {
        if (!msg) {
          return;
        }
        void handler(msg)
          .then(() => {
            channel.ack(msg);
          })
          .catch((error: unknown) => {
            this.logger.error({
              msg: 'rabbitmq_consumer_handler_failed',
              errorCode: error instanceof Error ? error.name : 'Error',
              operationResult: 'failure',
              err: error instanceof Error ? error.message : String(error),
            });
            // Nack without requeue for poison; transient errors should throw only after
            // retries inside the handler. Requeue once for unexpected failures.
            channel.nack(msg, false, true);
          });
      },
      { noAck: false },
    );
  }

  private async connect(): Promise<void> {
    const url = this.config.get<string>('RABBITMQ_URL');
    if (!url) {
      throw new Error('RABBITMQ_URL is required when messaging is enabled');
    }

    this.connection = await amqp.connect(url);
    this.channel = await this.connection.createChannel();
    await this.channel.assertExchange(CONVERSION_EXCHANGE_NAME, 'topic', { durable: true });
    await this.channel.assertQueue(CONVERSION_EXECUTION_ROUTING_KEY, { durable: true });
    await this.channel.bindQueue(
      CONVERSION_EXECUTION_ROUTING_KEY,
      CONVERSION_EXCHANGE_NAME,
      CONVERSION_EXECUTION_ROUTING_KEY,
    );
    await this.channel.prefetch(10);

    this.connection.on('error', (err: Error) => {
      this.logger.error({ msg: 'rabbitmq_connection_error', err: err.message });
    });
    this.connection.on('close', () => {
      this.logger.warn({ msg: 'rabbitmq_connection_closed' });
      this.channel = null;
      this.connection = null;
    });

    this.logger.log({
      msg: 'rabbitmq_connected',
      exchange: CONVERSION_EXCHANGE_NAME,
      queue: CONVERSION_EXECUTION_ROUTING_KEY,
    });
  }

  private async close(): Promise<void> {
    try {
      await this.channel?.close();
    } catch {
      // ignore close races
    }
    try {
      await this.connection?.close();
    } catch {
      // ignore close races
    }
    this.channel = null;
    this.connection = null;
  }
}
