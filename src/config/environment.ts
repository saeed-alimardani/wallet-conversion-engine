type Environment = Record<string, unknown>;

const BOOLEAN_KEYS = [
  'MESSAGING_ENABLED',
  'OUTBOX_PUBLISHER_ENABLED',
  'EXECUTION_CONSUMER_ENABLED',
  'IDEMPOTENCY_CLEANUP_ENABLED',
] as const;

const POSITIVE_INTEGER_KEYS = [
  'PORT',
  'OUTBOX_POLL_INTERVAL_MS',
  'OUTBOX_BATCH_SIZE',
  'RABBITMQ_CONNECT_MAX_ATTEMPTS',
  'RABBITMQ_RETRY_BASE_DELAY_MS',
  'RABBITMQ_RETRY_MAX_DELAY_MS',
  'RABBITMQ_PUBLISH_CONFIRM_TIMEOUT_MS',
  'IDEMPOTENCY_IN_PROGRESS_WAIT_MS',
  'IDEMPOTENCY_IN_PROGRESS_POLL_MS',
  'IDEMPOTENCY_RETENTION_HOURS',
  'IDEMPOTENCY_CLEANUP_INTERVAL_MS',
  'IDEMPOTENCY_CLEANUP_BATCH_SIZE',
] as const;

const LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);
const NODE_ENVIRONMENTS = new Set(['development', 'test', 'production']);
const EXCHANGE_MODES = new Set(['SUCCESS', 'FAILURE', 'UNKNOWN']);

export function validateEnvironment(environment: Environment): Environment {
  const databaseUrl = requiredString(environment, 'DATABASE_URL');
  assertUrlProtocol(databaseUrl, 'DATABASE_URL', ['postgres:', 'postgresql:']);

  for (const key of BOOLEAN_KEYS) {
    optionalBoolean(environment, key);
  }
  for (const key of POSITIVE_INTEGER_KEYS) {
    optionalPositiveInteger(environment, key);
  }
  optionalNonNegativeInteger(environment, 'RABBITMQ_CONSUMER_MAX_RETRIES');

  const port = optionalPositiveInteger(environment, 'PORT');
  if (port !== undefined && port > 65535) {
    throw new Error('PORT must be between 1 and 65535');
  }

  const messagingEnabled = optionalBoolean(environment, 'MESSAGING_ENABLED') ?? true;
  if (messagingEnabled) {
    const rabbitUrl = requiredString(environment, 'RABBITMQ_URL');
    assertUrlProtocol(rabbitUrl, 'RABBITMQ_URL', ['amqp:', 'amqps:']);
  }

  optionalEnum(environment, 'LOG_LEVEL', LOG_LEVELS);
  optionalEnum(environment, 'NODE_ENV', NODE_ENVIRONMENTS);
  optionalEnum(environment, 'FAKE_EXCHANGE_MODE', EXCHANGE_MODES);
  return environment;
}

function requiredString(environment: Environment, key: string): string {
  const value = environment[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function optionalBoolean(environment: Environment, key: string): boolean | undefined {
  const value = environment[key];
  if (value === undefined || value === '') {
    return undefined;
  }
  if (value === true || value === 'true') {
    return true;
  }
  if (value === false || value === 'false') {
    return false;
  }
  throw new Error(`${key} must be "true" or "false"`);
}

function optionalPositiveInteger(environment: Environment, key: string): number | undefined {
  const value = environment[key];
  if (value === undefined || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
}

function optionalNonNegativeInteger(environment: Environment, key: string): number | undefined {
  const value = environment[key];
  if (value === undefined || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }
  return parsed;
}

function optionalEnum(environment: Environment, key: string, allowed: ReadonlySet<string>): void {
  const value = environment[key];
  if (value === undefined || value === '') {
    return;
  }
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new Error(`${key} must be one of: ${[...allowed].join(', ')}`);
  }
}

function assertUrlProtocol(value: string, key: string, protocols: string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${key} must be a valid URL`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${key} must use ${protocols.join(' or ')}`);
  }
}
