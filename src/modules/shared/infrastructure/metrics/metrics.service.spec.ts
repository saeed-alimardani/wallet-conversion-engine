import { MetricsService } from './metrics.service';

const REQUIRED_METRICS = [
  'quote_created_total',
  'quote_acceptance_total',
  'quote_acceptance_failed_total',
  'conversion_completed_total',
  'conversion_failed_total',
  'outbox_pending_count',
  'outbox_publish_failure_total',
  'execution_retry_total',
  'http_request_duration_seconds',
  'wallet_reservation_conflict_total',
  'event_processing_duration_seconds',
];

describe('MetricsService', () => {
  let metrics: MetricsService;

  beforeEach(() => {
    metrics = new MetricsService();
    metrics.onModuleInit();
  });

  it('registers every required and bonus metric name from the spec', async () => {
    const text = await metrics.metricsText();
    for (const name of REQUIRED_METRICS) {
      expect(text).toContain(name);
    }
  });

  it('increments counters without high-cardinality identity labels', async () => {
    metrics.quoteCreatedTotal.inc();
    metrics.quoteAcceptanceTotal.inc();
    metrics.quoteAcceptanceFailedTotal.inc({ error_code: 'QUOTE_EXPIRED' });
    metrics.walletReservationConflictTotal.inc();
    metrics.conversionCompletedTotal.inc();
    metrics.conversionFailedTotal.inc();
    metrics.outboxPublishFailureTotal.inc();
    metrics.executionRetryTotal.inc();

    const text = await metrics.metricsText();
    expect(text).toMatch(/quote_created_total\s+1/);
    expect(text).toMatch(/quote_acceptance_failed_total\{error_code="QUOTE_EXPIRED"\}\s+1/);
    // Must not embed user/conversion identifiers as label names.
    expect(text).not.toMatch(/userId=/);
    expect(text).not.toMatch(/conversionId=/);
    expect(text).not.toMatch(/quoteId=/);
  });

  it('refreshes outbox_pending_count from the registered provider on scrape', async () => {
    metrics.setOutboxPendingCountProvider(() => Promise.resolve(7));
    const text = await metrics.metricsText();
    expect(text).toMatch(/outbox_pending_count\s+7/);
  });

  it('keeps the last gauge value when the pending provider throws', async () => {
    metrics.setOutboxPendingCountProvider(() => Promise.resolve(3));
    await metrics.metricsText();
    metrics.setOutboxPendingCountProvider(() => Promise.reject(new Error('db down')));
    const text = await metrics.metricsText();
    expect(text).toMatch(/outbox_pending_count\s+3/);
  });

  it('records histogram observations for HTTP and event processing', async () => {
    metrics.httpRequestDurationSeconds.observe(
      { method: 'GET', route: '/conversions/:conversionId', status_code: '200' },
      0.012,
    );
    metrics.eventProcessingDurationSeconds.observe({ outcome: 'success' }, 0.04);
    const text = await metrics.metricsText();
    expect(text).toContain('http_request_duration_seconds_bucket');
    expect(text).toContain('event_processing_duration_seconds_bucket');
    expect(text).toContain('route="/conversions/:conversionId"');
  });
});
