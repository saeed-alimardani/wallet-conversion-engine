import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/infrastructure/prisma/prisma.service';
import { PrismaDb } from '../../shared/infrastructure/prisma/prisma-client.types';
import { ConversionExecutionRequestedPayload, OutboxMessage } from '../domain/outbox-message';
import { OutboxRepository } from '../domain/ports/outbox-repository.port';

@Injectable()
export class PrismaOutboxRepository implements OutboxRepository {
  private readonly db: PrismaDb;

  constructor(prisma: PrismaService) {
    this.db = prisma;
  }

  static forTransaction(tx: PrismaDb): PrismaOutboxRepository {
    return new PrismaOutboxRepository(tx as PrismaService);
  }

  async enqueue(message: OutboxMessage): Promise<void> {
    await this.db.outboxMessage.create({
      data: {
        id: message.id,
        eventType: message.eventType,
        aggregateId: message.aggregateId,
        payload: message.payload as unknown as Prisma.InputJsonValue,
        createdAt: message.createdAt,
        publishedAt: message.publishedAt,
      },
    });
  }

  async findUnpublished(limit: number): Promise<OutboxMessage[]> {
    const rows = await this.db.outboxMessage.findMany({
      where: { publishedAt: null },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map((row) => this.toDomain(row));
  }

  async markPublished(id: string, publishedAt: Date): Promise<void> {
    await this.db.outboxMessage.updateMany({
      where: { id, publishedAt: null },
      data: { publishedAt },
    });
  }

  async countUnpublished(): Promise<number> {
    return this.db.outboxMessage.count({ where: { publishedAt: null } });
  }

  private toDomain(row: {
    id: string;
    eventType: string;
    aggregateId: string;
    payload: unknown;
    createdAt: Date;
    publishedAt: Date | null;
  }): OutboxMessage {
    const payload = row.payload as ConversionExecutionRequestedPayload;
    return OutboxMessage.createConversionExecutionRequested({
      id: row.id,
      payload,
      createdAt: row.createdAt,
    });
  }
}
