import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../shared/infrastructure/prisma/prisma.service';
import { FakeExchangeAdapter } from './fake-exchange.adapter';

describe('FakeExchangeAdapter', () => {
  function createPersistence(): PrismaService {
    const rows = new Map<string, Record<string, unknown>>();
    return {
      fakeExchangeExecution: {
        createMany: jest.fn(
          (args: { data: Array<Record<string, unknown>>; skipDuplicates: boolean }) => {
            const candidate = args.data[0];
            const clientOrderId = String(candidate.clientOrderId);
            const inserted = !rows.has(clientOrderId);
            if (inserted) {
              rows.set(clientOrderId, {
                ...candidate,
                reason: candidate.reason ?? null,
                createdAt: new Date(),
              });
            }
            return Promise.resolve({ count: inserted ? 1 : 0 });
          },
        ),
        findUniqueOrThrow: jest.fn((args: { where: { clientOrderId: string } }) => {
          const row = rows.get(args.where.clientOrderId);
          if (!row) {
            return Promise.reject(new Error('not found'));
          }
          return Promise.resolve(row);
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

  it('returns one stable result to concurrent duplicate executions', async () => {
    const adapter = createAdapter('SUCCESS');
    const results = await Promise.all(Array.from({ length: 20 }, () => adapter.execute(command)));

    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
  });

  it('rejects reuse of a clientOrderId for a different conversion command', async () => {
    const adapter = createAdapter();
    await adapter.execute(command);

    await expect(
      adapter.execute({ ...command, conversionId: 'different-conversion' }),
    ).rejects.toThrow(/different execution command/);
  });
});
