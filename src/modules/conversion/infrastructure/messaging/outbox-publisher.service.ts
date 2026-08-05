import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CLOCK } from '../../../shared/tokens';
import { Clock } from '../../../shared/domain/ports/clock.port';
import { MetricsService } from '../../../shared/infrastructure/metrics/metrics.service';
import { OutboxRepository } from '../../domain/ports/outbox-repository.port';
import { OUTBOX_REPOSITORY } from '../../tokens';
import { CONVERSION_EXECUTION_ROUTING_KEY } from './rabbitmq.constants';
import { RabbitMqConnection } from './rabbitmq.connection';

/**
 * Polls unpublished outbox rows in configurable batches and publishes them to RabbitMQ.
 * Residual duplicate-publish risk is accepted; the consumer is idempotent on eventId.
 */
@Injectable()
export class OutboxPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly autoStart: boolean;

  constructor(
    private readonly rabbit: RabbitMqConnection,
    private readonly config: ConfigService,
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly metrics: MetricsService,
  ) {
    this.pollIntervalMs = Number(this.config.get<string>('OUTBOX_POLL_INTERVAL_MS', '1000'));
    this.batchSize = Number(this.config.get<string>('OUTBOX_BATCH_SIZE', '100'));
    this.autoStart = this.config.get<string>('OUTBOX_PUBLISHER_ENABLED', 'true') !== 'false';
  }

  onModuleInit(): void {
    this.metrics.setOutboxPendingCountProvider(() => this.outbox.countUnpublished());

    if (!this.rabbit.isEnabled || !this.autoStart) {
      this.logger.warn('Outbox publisher auto-start disabled');
      return;
    }
    this.timer = setInterval(() => {
      void this.publishBatch().catch((error: unknown) => {
        this.metrics.outboxPublishFailureTotal.inc();
        this.logger.error({
          msg: 'outbox_publish_batch_failed',
          errorCode: 'OUTBOX_PUBLISH_FAILURE',
          operationResult: 'failure',
          err: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposed for tests and manual drains. */
  async publishBatch(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      const batch = await this.outbox.findUnpublished(this.batchSize);
      let published = 0;
      for (const message of batch) {
        try {
          await this.rabbit.publish(CONVERSION_EXECUTION_ROUTING_KEY, message.payload);
          await this.outbox.markPublished(message.id, this.clock.now());
          published += 1;
          this.logger.log({
            msg: 'outbox_message_published',
            eventId: message.id,
            conversionId: message.aggregateId,
            operationResult: 'success',
          });
        } catch (error: unknown) {
          this.metrics.outboxPublishFailureTotal.inc();
          this.logger.error({
            msg: 'outbox_message_publish_failed',
            eventId: message.id,
            conversionId: message.aggregateId,
            errorCode: 'OUTBOX_PUBLISH_FAILURE',
            operationResult: 'failure',
            err: error instanceof Error ? error.message : String(error),
          });
          break;
        }
      }
      return published;
    } finally {
      this.running = false;
    }
  }
}
