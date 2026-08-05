import { Money } from '../../shared/domain/money';
import { USDT, BTC } from '../../shared/domain/asset';
import { UserId } from '../../shared/domain/user-id';
import { QuoteId } from '../../pricing/domain/quote-id';
import { Conversion } from '../domain/conversion';
import { ConversionId } from '../domain/conversion-id';
import { ConversionRepository } from '../domain/ports/conversion-repository.port';
import { GetConversionUseCase, toConversionStatusResponse } from './get-conversion.use-case';

function buildConversion(
  status: 'FUNDS_RESERVED' | 'COMPLETED' | 'FAILED' | 'REQUIRES_RECONCILIATION',
) {
  const conversion = Conversion.create({
    id: ConversionId.of('11111111-1111-1111-1111-111111111111'),
    quoteId: QuoteId.of('22222222-2222-2222-2222-222222222222'),
    userId: UserId.of('user-123'),
    sourceAmount: Money.of('100', USDT),
    targetAmount: Money.of('0.00161', BTC),
    createdAt: new Date('2026-08-01T10:00:05.000Z'),
  });
  conversion.markFundsReserved();
  if (status === 'FUNDS_RESERVED') {
    return conversion;
  }
  conversion.markExecutionRequested('event-001');
  if (status === 'COMPLETED') {
    conversion.applyExecutionResult('SUCCESS', new Date('2026-08-01T10:00:08.000Z'));
  } else if (status === 'FAILED') {
    conversion.applyExecutionResult('FAILURE', new Date('2026-08-01T10:00:08.000Z'), 'simulated');
  } else {
    conversion.applyExecutionResult('UNKNOWN', new Date('2026-08-01T10:00:08.000Z'));
  }
  return conversion;
}

describe('toConversionStatusResponse', () => {
  it('maps a COMPLETED conversion to the spec response shape', () => {
    const body = toConversionStatusResponse(buildConversion('COMPLETED'));
    expect(body).toEqual({
      conversionId: '11111111-1111-1111-1111-111111111111',
      status: 'COMPLETED',
      sourceAsset: 'USDT',
      targetAsset: 'BTC',
      sourceAmount: '100',
      targetAmount: '0.00161',
      createdAt: '2026-08-01T10:00:05Z',
      completedAt: '2026-08-01T10:00:08Z',
    });
  });

  it('returns null completedAt for non-terminal FUNDS_RESERVED', () => {
    const body = toConversionStatusResponse(buildConversion('FUNDS_RESERVED'));
    expect(body.status).toBe('FUNDS_RESERVED');
    expect(body.completedAt).toBeNull();
  });

  it('maps FAILED and REQUIRES_RECONCILIATION statuses', () => {
    expect(toConversionStatusResponse(buildConversion('FAILED')).status).toBe('FAILED');
    expect(toConversionStatusResponse(buildConversion('REQUIRES_RECONCILIATION')).status).toBe(
      'REQUIRES_RECONCILIATION',
    );
  });
});

describe('GetConversionUseCase', () => {
  const findById = jest.fn<
    ReturnType<ConversionRepository['findById']>,
    Parameters<ConversionRepository['findById']>
  >();
  const repo: ConversionRepository = {
    save: jest.fn(),
    findById,
    markExecutionRequestedIfFundsReserved: jest.fn(),
  };

  const useCase = new GetConversionUseCase(repo);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns found for an existing conversion', async () => {
    findById.mockResolvedValue(buildConversion('COMPLETED'));
    const result = await useCase.execute('11111111-1111-1111-1111-111111111111');
    expect(result.kind).toBe('found');
    if (result.kind === 'found') {
      expect(result.body.status).toBe('COMPLETED');
      expect(result.body.sourceAmount).toBe('100');
    }
  });

  it('returns not_found when the repository has no row', async () => {
    findById.mockResolvedValue(null);
    const result = await useCase.execute('33333333-3333-3333-3333-333333333333');
    expect(result).toEqual({ kind: 'not_found' });
  });

  it('returns invalid_id for empty / whitespace conversionId', async () => {
    await expect(useCase.execute('')).resolves.toMatchObject({ kind: 'invalid_id' });
    await expect(useCase.execute('   ')).resolves.toMatchObject({ kind: 'invalid_id' });
    expect(findById).not.toHaveBeenCalled();
  });

  it('trims conversionId before lookup', async () => {
    findById.mockResolvedValue(buildConversion('FUNDS_RESERVED'));
    await useCase.execute('  11111111-1111-1111-1111-111111111111  ');
    expect(findById).toHaveBeenCalledWith(
      expect.objectContaining({ value: '11111111-1111-1111-1111-111111111111' }),
    );
  });
});
