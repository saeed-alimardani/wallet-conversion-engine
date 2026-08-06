import { Module } from '@nestjs/common';
import { SharedModule } from '../shared/shared.module';
import { PricingModule } from '../pricing/pricing.module';
import { WalletModule } from '../wallet/wallet.module';
import { AcceptQuoteUseCase } from './application/accept-quote.use-case';
import { GetConversionUseCase } from './application/get-conversion.use-case';
import { ProcessConversionExecutionUseCase } from './application/process-conversion-execution.use-case';
import { FakeExchangeAdapter } from './infrastructure/fake-exchange.adapter';
import { IdempotencyCleanupService } from './infrastructure/idempotency-cleanup.service';
import { PrismaConversionRepository } from './infrastructure/prisma-conversion.repository';
import { PrismaIdempotencyRepository } from './infrastructure/prisma-idempotency.repository';
import { PrismaOutboxRepository } from './infrastructure/prisma-outbox.repository';
import { PrismaProcessedMessageRepository } from './infrastructure/prisma-processed-message.repository';
import { PrismaUnitOfWork } from './infrastructure/prisma-unit-of-work';
import { ExecutionConsumerService } from './infrastructure/messaging/execution-consumer.service';
import { OutboxPublisherService } from './infrastructure/messaging/outbox-publisher.service';
import { RabbitMqConnection } from './infrastructure/messaging/rabbitmq.connection';
import { AcceptQuoteController } from './presentation/accept-quote.controller';
import { ConversionsController } from './presentation/conversions.controller';
import {
  CONVERSION_REPOSITORY,
  EXCHANGE_EXECUTION,
  IDEMPOTENCY_REPOSITORY,
  OUTBOX_REPOSITORY,
  PROCESSED_MESSAGE_REPOSITORY,
  UNIT_OF_WORK,
} from './tokens';

@Module({
  imports: [SharedModule, PricingModule, WalletModule],
  controllers: [AcceptQuoteController, ConversionsController],
  providers: [
    AcceptQuoteUseCase,
    GetConversionUseCase,
    ProcessConversionExecutionUseCase,
    PrismaUnitOfWork,
    RabbitMqConnection,
    OutboxPublisherService,
    ExecutionConsumerService,
    FakeExchangeAdapter,
    IdempotencyCleanupService,
    { provide: UNIT_OF_WORK, useExisting: PrismaUnitOfWork },
    { provide: CONVERSION_REPOSITORY, useClass: PrismaConversionRepository },
    { provide: OUTBOX_REPOSITORY, useClass: PrismaOutboxRepository },
    { provide: PROCESSED_MESSAGE_REPOSITORY, useClass: PrismaProcessedMessageRepository },
    { provide: IDEMPOTENCY_REPOSITORY, useClass: PrismaIdempotencyRepository },
    { provide: EXCHANGE_EXECUTION, useExisting: FakeExchangeAdapter },
  ],
  exports: [
    CONVERSION_REPOSITORY,
    OUTBOX_REPOSITORY,
    PROCESSED_MESSAGE_REPOSITORY,
    IDEMPOTENCY_REPOSITORY,
    UNIT_OF_WORK,
    EXCHANGE_EXECUTION,
    FakeExchangeAdapter,
    OutboxPublisherService,
    ProcessConversionExecutionUseCase,
    GetConversionUseCase,
  ],
})
export class ConversionModule {}
