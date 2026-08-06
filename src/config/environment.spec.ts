import { validateEnvironment } from './environment';

const validEnvironment = {
  DATABASE_URL: 'postgresql://wallet:wallet@localhost:5432/wallet',
  RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
};

describe('validateEnvironment', () => {
  it('accepts the minimal messaging-enabled configuration', () => {
    expect(validateEnvironment({ ...validEnvironment })).toEqual(validEnvironment);
  });

  it('does not require RabbitMQ when messaging is disabled', () => {
    expect(
      validateEnvironment({
        DATABASE_URL: validEnvironment.DATABASE_URL,
        MESSAGING_ENABLED: 'false',
      }),
    ).toBeTruthy();
  });

  it.each([
    [{ RABBITMQ_CONNECT_MAX_ATTEMPTS: '0' }, 'RABBITMQ_CONNECT_MAX_ATTEMPTS'],
    [{ RABBITMQ_CONSUMER_MAX_RETRIES: '-1' }, 'RABBITMQ_CONSUMER_MAX_RETRIES'],
    [{ PORT: '65536' }, 'PORT'],
    [{ MESSAGING_ENABLED: 'yes' }, 'MESSAGING_ENABLED'],
    [{ LOG_LEVEL: 'verbose' }, 'LOG_LEVEL'],
    [{ FAKE_EXCHANGE_MODE: 'RANDOM' }, 'FAKE_EXCHANGE_MODE'],
  ])('rejects invalid bounded configuration %j', (override, expectedKey) => {
    expect(() => validateEnvironment({ ...validEnvironment, ...override })).toThrow(expectedKey);
  });

  it('rejects missing and malformed service URLs', () => {
    expect(() => validateEnvironment({ RABBITMQ_URL: validEnvironment.RABBITMQ_URL })).toThrow(
      'DATABASE_URL',
    );
    expect(() =>
      validateEnvironment({ ...validEnvironment, RABBITMQ_URL: 'https://rabbit.example' }),
    ).toThrow('RABBITMQ_URL');
  });
});
