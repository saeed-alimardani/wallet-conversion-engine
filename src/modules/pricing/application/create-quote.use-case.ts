import { Inject, Injectable } from '@nestjs/common';
import { Asset } from '../../shared/domain/asset';
import { Money } from '../../shared/domain/money';
import { UserId } from '../../shared/domain/user-id';
import { CLOCK, ID_GENERATOR } from '../../shared/tokens';
import { Clock } from '../../shared/domain/ports/clock.port';
import { IdGenerator } from '../../shared/domain/ports/id-generator.port';
import { Quote } from '../domain/quote';
import { QuoteId } from '../domain/quote-id';
import { PricingProvider } from '../domain/ports/pricing-provider.port';
import { QuoteRepository } from '../domain/ports/quote-repository.port';
import { PRICING_PROVIDER, QUOTE_REPOSITORY } from '../tokens';

export interface CreateQuoteCommand {
  userId: string;
  sourceAsset: string;
  targetAsset: string;
  sourceAmount: string;
}

export class InvalidQuoteRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidQuoteRequestError';
  }
}

@Injectable()
export class CreateQuoteUseCase {
  constructor(
    @Inject(QUOTE_REPOSITORY) private readonly quotes: QuoteRepository,
    @Inject(PRICING_PROVIDER) private readonly pricing: PricingProvider,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: CreateQuoteCommand): Promise<Quote> {
    let quote: Quote;
    try {
      const userId = UserId.of(command.userId);
      const sourceAsset = Asset.of(command.sourceAsset);
      const targetAsset = Asset.of(command.targetAsset);
      const sourceAmount = Money.of(command.sourceAmount, sourceAsset);

      const rate = this.pricing.getRate(sourceAsset, targetAsset);
      quote = Quote.create({
        id: QuoteId.of(this.ids.generate()),
        userId,
        sourceAmount,
        rate,
        createdAt: this.clock.now(),
      });
    } catch (error: unknown) {
      throw new InvalidQuoteRequestError(
        error instanceof Error ? error.message : 'Quote request is invalid',
      );
    }

    // Persistence failures are deliberately outside the input-error boundary.
    // They must surface as 500s rather than being leaked or misreported as client errors.
    await this.quotes.save(quote);
    return quote;
  }
}
