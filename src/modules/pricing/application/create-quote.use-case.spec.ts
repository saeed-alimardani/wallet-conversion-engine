import { CreateQuoteUseCase, InvalidQuoteRequestError } from './create-quote.use-case';
import { QuoteRepository } from '../domain/ports/quote-repository.port';
import { FakePricingProvider } from '../infrastructure/fake-pricing.provider';

describe('CreateQuoteUseCase error boundaries', () => {
  const command = {
    userId: 'user-1',
    sourceAsset: 'USDT',
    targetAsset: 'BTC',
    sourceAmount: '10',
  };

  it('classifies domain input failures as invalid requests', async () => {
    const useCase = createUseCase({ save: jest.fn() });

    await expect(useCase.execute({ ...command, sourceAsset: 'DOGE' })).rejects.toBeInstanceOf(
      InvalidQuoteRequestError,
    );
  });

  it('does not misclassify or expose persistence failures as input errors', async () => {
    const infrastructureFailure = new Error('database connection failed');
    const useCase = createUseCase({
      save: jest.fn().mockRejectedValue(infrastructureFailure),
    });

    await expect(useCase.execute(command)).rejects.toBe(infrastructureFailure);
  });
});

function createUseCase(quotes: Partial<QuoteRepository>): CreateQuoteUseCase {
  return new CreateQuoteUseCase(
    quotes as QuoteRepository,
    new FakePricingProvider(),
    { now: () => new Date('2026-08-06T00:00:00.000Z') },
    { generate: () => '8e7857a8-91bd-4fde-b18d-fb7084528156' },
  );
}
