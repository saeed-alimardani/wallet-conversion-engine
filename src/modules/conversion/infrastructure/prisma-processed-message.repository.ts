import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/infrastructure/prisma/prisma.service';
import { PrismaDb } from '../../shared/infrastructure/prisma/prisma-client.types';
import { ExecutionOutcome } from '../domain/conversion';
import { ProcessedMessageRepository } from '../domain/ports/processed-message-repository.port';

@Injectable()
export class PrismaProcessedMessageRepository implements ProcessedMessageRepository {
  private readonly db: PrismaDb;

  constructor(prisma: PrismaService) {
    this.db = prisma;
  }

  static forTransaction(tx: PrismaDb): PrismaProcessedMessageRepository {
    return new PrismaProcessedMessageRepository(tx as PrismaService);
  }

  async exists(eventId: string): Promise<boolean> {
    const row = await this.db.processedMessage.findUnique({
      where: { eventId },
      select: { eventId: true },
    });
    return row !== null;
  }

  async tryRecord(
    eventId: string,
    conversionId: string,
    outcome: ExecutionOutcome,
  ): Promise<boolean> {
    const rows = await this.db.$queryRaw<Array<{ event_id: string }>>`
      INSERT INTO processed_messages (event_id, conversion_id, outcome, processed_at)
      VALUES (${eventId}, ${conversionId}, ${outcome}, NOW())
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id
    `;
    return rows.length > 0;
  }
}
