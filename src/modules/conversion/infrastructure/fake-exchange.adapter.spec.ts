import { ConfigService } from '@nestjs/config';
import { FakeExchangeAdapter } from './fake-exchange.adapter';

describe('FakeExchangeAdapter', () => {
  function createAdapter(mode = 'SUCCESS'): FakeExchangeAdapter {
    return new FakeExchangeAdapter({
      get: (_key: string, defaultValue?: string) => mode || defaultValue,
    } as unknown as ConfigService);
  }

  const command = {
    clientOrderId: 'event-001',
    conversionId: 'conversion-001',
    userId: 'user-123',
    sourceAsset: 'USDT',
    targetAsset: 'BTC',
    sourceAmount: '100',
    targetAmount: '0.00161',
  };

  it('returns SUCCESS by default and memoizes by clientOrderId', async () => {
    const adapter = createAdapter('SUCCESS');
    const first = await adapter.execute(command);
    const second = await adapter.execute(command);
    expect(first.outcome).toBe('SUCCESS');
    expect(second).toEqual(first);
  });

  it('honours per-order FAILURE without changing the default mode', async () => {
    const adapter = createAdapter('SUCCESS');
    adapter.setModeForClientOrder('event-fail', 'FAILURE');
    const failed = await adapter.execute({ ...command, clientOrderId: 'event-fail' });
    const ok = await adapter.execute({ ...command, clientOrderId: 'event-ok' });
    expect(failed.outcome).toBe('FAILURE');
    expect(ok.outcome).toBe('SUCCESS');
  });

  it('returns UNKNOWN for timeout simulation and is stable on retry', async () => {
    const adapter = createAdapter('UNKNOWN');
    const first = await adapter.execute(command);
    const second = await adapter.execute(command);
    expect(first.outcome).toBe('UNKNOWN');
    expect(second.outcome).toBe('UNKNOWN');
  });
});
