/**
 * Deterministic e2e/integration env, applied before AppModule is imported.
 * RabbitMQ stays available for tests that publish explicitly, while background
 * publisher/consumer loops remain disabled.
 */
process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
process.env.EXECUTION_CONSUMER_ENABLED = 'false';
process.env.IDEMPOTENCY_CLEANUP_ENABLED = 'false';
process.env.MESSAGING_ENABLED = 'true';
process.env.FAKE_EXCHANGE_MODE = 'SUCCESS';
// Concurrent same-key losers poll for the winner's stored response (accept use case).
process.env.IDEMPOTENCY_IN_PROGRESS_WAIT_MS = '3000';
process.env.IDEMPOTENCY_IN_PROGRESS_POLL_MS = '20';
