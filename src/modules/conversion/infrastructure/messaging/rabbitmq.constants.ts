/** Routing key / queue name for conversion execution requests (plan §7). */
export const CONVERSION_EXECUTION_ROUTING_KEY = 'conversion.execution.requested';
export const CONVERSION_EXCHANGE_NAME = 'conversion.events';
export const CONVERSION_EXECUTION_DEAD_LETTER_ROUTING_KEY =
  'conversion.execution.requested.dead-letter';
export const CONVERSION_EXECUTION_DEAD_LETTER_QUEUE = 'conversion.execution.requested.dead-letter';
