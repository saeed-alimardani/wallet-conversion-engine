import { ConfigService } from '@nestjs/config';
import { Clock } from '../../shared/domain/ports/clock.port';
import { IdempotencyRepository } from '../domain/ports/idempotency-repository.port';
import { IdempotencyCleanupService } from './idempotency-cleanup.service';

describe('IdempotencyCleanupService', () => {
  function setup(deleteExpired: jest.Mock = jest.fn().mockResolvedValue(0)): {
    service: IdempotencyCleanupService;
    deleteExpired: jest.Mock;
  } {
    const repository: IdempotencyRepository = {
      find: jest.fn(),
      tryBegin: jest.fn(),
      complete: jest.fn(),
      deleteExpired,
    };
    const clock: Clock = { now: () => new Date('2026-08-06T12:00:00.000Z') };
    const config = {
      get: (key: string, defaultValue?: string) => {
        const values: Record<string, string> = {
          IDEMPOTENCY_RETENTION_HOURS: '24',
          IDEMPOTENCY_CLEANUP_INTERVAL_MS: '3600000',
          IDEMPOTENCY_CLEANUP_BATCH_SIZE: '250',
        };
        return values[key] ?? defaultValue;
      },
    } as unknown as ConfigService;
    return {
      service: new IdempotencyCleanupService(repository, clock, config),
      deleteExpired,
    };
  }

  it('deletes one bounded batch older than the configured retention period', async () => {
    const { service, deleteExpired } = setup(jest.fn().mockResolvedValue(17));

    await expect(service.cleanupBatch()).resolves.toBe(17);
    expect(deleteExpired).toHaveBeenCalledWith(new Date('2026-08-05T12:00:00.000Z'), 250);
  });

  it('does not overlap cleanup batches', async () => {
    let resolveDelete!: (count: number) => void;
    const deleteExpired = jest.fn(
      () =>
        new Promise<number>((resolve) => {
          resolveDelete = resolve;
        }),
    );
    const { service } = setup(deleteExpired);

    const first = service.cleanupBatch();
    await expect(service.cleanupBatch()).resolves.toBe(0);
    resolveDelete(3);
    await expect(first).resolves.toBe(3);
  });
});
