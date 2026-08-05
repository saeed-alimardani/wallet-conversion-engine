import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/infrastructure/prisma/prisma.service';
import { PrismaDb } from '../../shared/infrastructure/prisma/prisma-client.types';
import {
  IdempotencyLookup,
  IdempotencyRepository,
} from '../domain/ports/idempotency-repository.port';

@Injectable()
export class PrismaIdempotencyRepository implements IdempotencyRepository {
  private readonly db: PrismaDb;

  constructor(prisma: PrismaService) {
    this.db = prisma;
  }

  static forTransaction(tx: PrismaDb): PrismaIdempotencyRepository {
    return new PrismaIdempotencyRepository(tx as PrismaService);
  }

  async find(scope: string, key: string): Promise<IdempotencyLookup> {
    const row = await this.db.idempotencyRecord.findUnique({
      where: { scope_idempotencyKey: { scope, idempotencyKey: key } },
    });
    if (!row) {
      return { kind: 'missing' };
    }
    if (row.responseStatus === null || row.responseBody === null) {
      return { kind: 'in-progress', requestHash: row.requestHash };
    }
    return {
      kind: 'completed',
      requestHash: row.requestHash,
      responseStatus: row.responseStatus,
      responseBody: row.responseBody,
      conversionId: row.conversionId,
    };
  }

  /**
   * Claim the idempotency key with INSERT … ON CONFLICT DO NOTHING.
   * Must not use a throwing unique-violation path — in PostgreSQL that aborts the
   * current transaction (SQLSTATE 25P02), preventing the subsequent find/replay.
   */
  async tryBegin(scope: string, key: string, requestHash: string): Promise<boolean> {
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`
      INSERT INTO idempotency_records (id, scope, idempotency_key, request_hash, created_at, updated_at)
      VALUES (gen_random_uuid()::text, ${scope}, ${key}, ${requestHash}, NOW(), NOW())
      ON CONFLICT (scope, idempotency_key) DO NOTHING
      RETURNING id
    `;
    return rows.length > 0;
  }

  async complete(
    scope: string,
    key: string,
    response: { responseStatus: number; responseBody: unknown; conversionId: string },
  ): Promise<void> {
    await this.db.idempotencyRecord.update({
      where: { scope_idempotencyKey: { scope, idempotencyKey: key } },
      data: {
        responseStatus: response.responseStatus,
        responseBody: response.responseBody as Prisma.InputJsonValue,
        conversionId: response.conversionId,
      },
    });
  }
}
