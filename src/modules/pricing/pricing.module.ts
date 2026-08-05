import { Module } from '@nestjs/common';
import { SharedModule } from '../shared/shared.module';
import { CreateQuoteUseCase } from './application/create-quote.use-case';
import { FakePricingProvider } from './infrastructure/fake-pricing.provider';
import { PrismaQuoteRepository } from './infrastructure/prisma-quote.repository';
import { QuotesController } from './presentation/quotes.controller';
import { PRICING_PROVIDER, QUOTE_REPOSITORY } from './tokens';

@Module({
  imports: [SharedModule],
  controllers: [QuotesController],
  providers: [
    CreateQuoteUseCase,
    { provide: QUOTE_REPOSITORY, useClass: PrismaQuoteRepository },
    { provide: PRICING_PROVIDER, useClass: FakePricingProvider },
  ],
  exports: [QUOTE_REPOSITORY, PRICING_PROVIDER],
})
export class PricingModule {}
