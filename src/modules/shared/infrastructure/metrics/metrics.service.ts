import { Injectable, OnModuleInit } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics for the challenge (spec §13).
 * Labels are low-cardinality only — never userId / conversionId / quoteId.
 */
@Injectable()
export class MetricsService implements OnModuleInit {
  readonly registry = new Registry();

  readonly quoteCreatedTotal: Counter<string>;
  readonly quoteAcceptanceTotal: Counter<string>;
  readonly quoteAcceptanceFailedTotal: Counter<string>;
  readonly conversionCompletedTotal: Counter<string>;
  readonly conversionFailedTotal: Counter<string>;
  readonly outboxPendingCount: Gauge<string>;
  readonly outboxPublishFailureTotal: Counter<string>;
  readonly executionRetryTotal: Counter<string>;
  readonly httpRequestDurationSeconds: Histogram<string>;
  readonly walletReservationConflictTotal: Counter<string>;
  readonly eventProcessingDurationSeconds: Histogram<string>;

  private pendingCountProvider: (() => Promise<number>) | null = null;

  constructor() {
    this.quoteCreatedTotal = new Counter({
      name: 'quote_created_total',
      help: 'Total number of quotes created',
      registers: [this.registry],
    });
    this.quoteAcceptanceTotal = new Counter({
      name: 'quote_acceptance_total',
      help: 'Total number of successful quote acceptances (including idempotent replays of success)',
      registers: [this.registry],
    });
    this.quoteAcceptanceFailedTotal = new Counter({
      name: 'quote_acceptance_failed_total',
      help: 'Total number of failed quote acceptance attempts',
      labelNames: ['error_code'],
      registers: [this.registry],
    });
    this.conversionCompletedTotal = new Counter({
      name: 'conversion_completed_total',
      help: 'Total number of conversions completed successfully',
      registers: [this.registry],
    });
    this.conversionFailedTotal = new Counter({
      name: 'conversion_failed_total',
      help: 'Total number of conversions that failed execution',
      registers: [this.registry],
    });
    this.outboxPendingCount = new Gauge({
      name: 'outbox_pending_count',
      help: 'Approximate number of unpublished outbox messages',
      registers: [this.registry],
    });
    this.outboxPublishFailureTotal = new Counter({
      name: 'outbox_publish_failure_total',
      help: 'Total number of outbox publish failures',
      registers: [this.registry],
    });
    this.executionRetryTotal = new Counter({
      name: 'execution_retry_total',
      help: 'Total number of duplicate/retry execution deliveries short-circuited by idempotency',
      registers: [this.registry],
    });
    this.httpRequestDurationSeconds = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });
    this.walletReservationConflictTotal = new Counter({
      name: 'wallet_reservation_conflict_total',
      help: 'Total wallet reservation conflicts / insufficient available balance on accept',
      registers: [this.registry],
    });
    this.eventProcessingDurationSeconds = new Histogram({
      name: 'event_processing_duration_seconds',
      help: 'Duration of conversion execution event processing in seconds',
      labelNames: ['outcome'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });
  }

  onModuleInit(): void {
    collectDefaultMetrics({ register: this.registry });
  }

  /** Register a callback used to refresh `outbox_pending_count` on scrape. */
  setOutboxPendingCountProvider(provider: () => Promise<number>): void {
    this.pendingCountProvider = provider;
  }

  async metricsText(): Promise<string> {
    if (this.pendingCountProvider) {
      try {
        const pending = await this.pendingCountProvider();
        this.outboxPendingCount.set(pending);
      } catch {
        // Leave the last known gauge value if the provider fails.
      }
    }
    return this.registry.metrics();
  }
}
