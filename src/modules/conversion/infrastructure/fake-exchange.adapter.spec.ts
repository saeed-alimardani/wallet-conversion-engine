import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../shared/infrastructure/prisma/prisma.service';
import { FakeExchangeAdapter } from './fake-exchange.adapter';

describe('FakeExchangeAdapter', () => {
  function createPersistence(): PrismaService {
    const rows = new Map<string, Record<string, unknown>>();
    return {
      fakeExchangeExecution: {
        upsert: jest.fn(
          (args: { where: { clientOrderId: string }; create: Record<string, unknown> }) => {
            const existing = rows.get(args.where.clientOrderId);
            if (existing) {
              return Promise.resolve(existing);
            }
            const created = {
              ...args.create,
              reason: args.create.reason ?? null,
              createdAt: new Date(),
            };
            rows.set(args.where.clientOrderId, created);
            return Promise.resolve(created);
          },
        ),
        deleteMany: jest.fn(() => {
          rows.clear();
          return Promise.resolve({ count: 0 });
        }),
      },
    } as unknown as PrismaService;
  }

  function createAdapter(
    mode = 'SUCCESS',
    persistence: PrismaService = createPersistence(),
  ): FakeExchangeAdapter {
    return new FakeExchangeAdapter(
      {
        get: (_key: string, defaultValue?: string) => mode || defaultValue,
      } as unknown as ConfigService,
      persistence,
    );
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

  it('returns the persisted result after adapter restart even if the configured mode changes', async () => {
    const persistence = createPersistence();
    const beforeRestart = createAdapter('SUCCESS', persistence);
    expect((await beforeRestart.execute(command)).outcome).toBe('SUCCESS');

    const afterRestart = createAdapter('FAILURE', persistence);
    expect((await afterRestart.execute(command)).outcome).toBe('SUCCESS');
  });

  it('rejects reuse of a clientOrderId for a different conversion command', async () => {
    const adapter = createAdapter();
    await adapter.execute(command);

    await expect(
      adapter.execute({ ...command, conversionId: 'different-conversion' }),
    ).rejects.toThrow(/different execution command/);
  });
});
