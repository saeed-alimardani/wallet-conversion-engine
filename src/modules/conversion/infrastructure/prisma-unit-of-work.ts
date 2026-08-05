import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/infrastructure/prisma/prisma.service';
import { PrismaQuoteRepository } from '../../pricing/infrastructure/prisma-quote.repository';
import { PrismaWalletRepository } from '../../wallet/infrastructure/prisma-wallet.repository';
import { UnitOfWork, UnitOfWorkContext } from '../domain/ports/unit-of-work.port';
import { PrismaConversionRepository } from './prisma-conversion.repository';
import { PrismaOutboxRepository } from './prisma-outbox.repository';
import { PrismaIdempotencyRepository } from './prisma-idempotency.repository';
import { PrismaProcessedMessageRepository } from './prisma-processed-message.repository';

@Injectable()
export class PrismaUnitOfWork implements UnitOfWork {
  constructor(private readonly prisma: PrismaService) {}

  execute<T>(work: (ctx: UnitOfWorkContext) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const ctx: UnitOfWorkContext = {
        quotes: PrismaQuoteRepository.forTransaction(tx),
        wallets: PrismaWalletRepository.forTransaction(tx),
        conversions: PrismaConversionRepository.forTransaction(tx),
        outbox: PrismaOutboxRepository.forTransaction(tx),
        idempotency: PrismaIdempotencyRepository.forTransaction(tx),
        processedMessages: PrismaProcessedMessageRepository.forTransaction(tx),
      };
      return work(ctx);
    });
  }
}
