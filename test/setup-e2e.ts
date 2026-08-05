/**
 * Default e2e/integration env: do not start outbox/consumer loops or open RabbitMQ
 * unless a suite explicitly opts in (see execution.integration-spec.ts).
 */
process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
process.env.EXECUTION_CONSUMER_ENABLED = 'false';
if (process.env.MESSAGING_ENABLED === undefined) {
  process.env.MESSAGING_ENABLED = 'false';
}
// Concurrent same-key losers poll for the winner's stored response (accept use case).
if (process.env.IDEMPOTENCY_IN_PROGRESS_WAIT_MS === undefined) {
  process.env.IDEMPOTENCY_IN_PROGRESS_WAIT_MS = '3000';
}
if (process.env.IDEMPOTENCY_IN_PROGRESS_POLL_MS === undefined) {
  process.env.IDEMPOTENCY_IN_PROGRESS_POLL_MS = '20';
}
