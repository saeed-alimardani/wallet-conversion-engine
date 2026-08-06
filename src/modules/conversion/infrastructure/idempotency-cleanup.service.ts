import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Clock } from '../../shared/domain/ports/clock.port';
import { CLOCK } from '../../shared/tokens';
import { IdempotencyRepository } from '../domain/ports/idempotency-repository.port';
import { IDEMPOTENCY_REPOSITORY } from '../tokens';

@Injectable()
export class IdempotencyCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IdempotencyCleanupService.name);
  private readonly enabled: boolean;
  private readonly retentionMs: number;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(IDEMPOTENCY_REPOSITORY) private readonly idempotency: IdempotencyRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    config: ConfigService,
  ) {
    const defaultEnabled = config.get<string>('NODE_ENV') === 'test' ? 'false' : 'true';
    this.enabled = config.get<string>('IDEMPOTENCY_CLEANUP_ENABLED', defaultEnabled) !== 'false';
    this.retentionMs =
      this.positiveInteger(config, 'IDEMPOTENCY_RETENTION_HOURS', 24) * 60 * 60 * 1000;
    this.intervalMs = this.positiveInteger(
      config,
      'IDEMPOTENCY_CLEANUP_INTERVAL_MS',
      60 * 60 * 1000,
    );
    this.batchSize = this.positiveInteger(config, 'IDEMPOTENCY_CLEANUP_BATCH_SIZE', 1000);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn('Idempotency cleanup disabled');
      return;
    }
    void this.cleanupBatch().catch((error: unknown) => this.logFailure(error));
    this.timer = setInterval(() => {
      void this.cleanupBatch().catch((error: unknown) => this.logFailure(error));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async cleanupBatch(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      const cutoff = new Date(this.clock.now().getTime() - this.retentionMs);
      const deleted = await this.idempotency.deleteExpired(cutoff, this.batchSize);
      if (deleted > 0) {
        this.logger.log({
          msg: 'idempotency_records_deleted',
          deleted,
          cutoff: cutoff.toISOString(),
          operationResult: 'success',
        });
      }
      return deleted;
    } finally {
      this.running = false;
    }
  }

  private positiveInteger(config: ConfigService, key: string, fallback: number): number {
    const value = Number(config.get<string>(key, String(fallback)));
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${key} must be a positive integer`);
    }
    return value;
  }

  private logFailure(error: unknown): void {
    this.logger.error({
      msg: 'idempotency_cleanup_failed',
      errorCode: error instanceof Error ? error.name : 'Error',
      operationResult: 'failure',
    });
  }
}
