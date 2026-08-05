import { QuoteRepository } from '../../../pricing/domain/ports/quote-repository.port';
import { WalletRepository } from '../../../wallet/domain/ports/wallet-repository.port';
import { ConversionRepository } from './conversion-repository.port';
import { OutboxRepository } from './outbox-repository.port';
import { IdempotencyRepository } from './idempotency-repository.port';
import { ProcessedMessageRepository } from './processed-message-repository.port';

/**
 * Single PostgreSQL transaction boundary for accept / settle orchestration.
 * All repositories on the context share the same transactional client.
 */
export interface UnitOfWorkContext {
  quotes: QuoteRepository;
  wallets: WalletRepository;
  conversions: ConversionRepository;
  outbox: OutboxRepository;
  idempotency: IdempotencyRepository;
  processedMessages: ProcessedMessageRepository;
}

export interface UnitOfWork {
  execute<T>(work: (ctx: UnitOfWorkContext) => Promise<T>): Promise<T>;
}
