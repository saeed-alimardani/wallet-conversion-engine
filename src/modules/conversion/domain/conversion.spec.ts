import { randomUUID } from 'crypto';
import { Money } from '../../shared/domain/money';
import { USDT, BTC } from '../../shared/domain/asset';
import { UserId } from '../../shared/domain/user-id';
import { QuoteId } from '../../pricing/domain/quote-id';
import { ConversionId } from './conversion-id';
import {
  ConflictingExecutionResultError,
  Conversion,
  InvalidConversionTransitionError,
} from './conversion';

function createConversion(): Conversion {
  return Conversion.create({
    id: ConversionId.of(randomUUID()),
    quoteId: QuoteId.of(randomUUID()),
    userId: UserId.of('user-123'),
    sourceAmount: Money.of('100', USDT),
    targetAmount: Money.of('0.00161', BTC),
    createdAt: new Date('2026-08-01T10:00:05.000Z'),
  });
}

describe('Conversion', () => {
  it('starts in CREATED', () => {
    expect(createConversion().status).toBe('CREATED');
  });

  it('CREATED → FUNDS_RESERVED', () => {
    const conversion = createConversion();
    conversion.markFundsReserved();
    expect(conversion.status).toBe('FUNDS_RESERVED');
  });

  it('rejects invalid transition from CREATED to execution result', () => {
    const conversion = createConversion();
    expect(() => conversion.applyExecutionResult('SUCCESS', new Date())).toThrow(
      InvalidConversionTransitionError,
    );
  });

  it('FUNDS_RESERVED → EXECUTION_REQUESTED with exchangeExecutionId', () => {
    const conversion = createConversion();
    conversion.markFundsReserved();
    conversion.markExecutionRequested('exec-001');
    expect(conversion.status).toBe('EXECUTION_REQUESTED');
    expect(conversion.exchangeExecutionId).toBe('exec-001');
  });

  it('EXECUTION_REQUESTED → COMPLETED on SUCCESS', () => {
    const conversion = createConversion();
    conversion.markFundsReserved();
    conversion.markExecutionRequested('exec-001');
    const at = new Date('2026-08-01T10:00:08.000Z');
    conversion.applyExecutionResult('SUCCESS', at);
    expect(conversion.status).toBe('COMPLETED');
    expect(conversion.completedAt?.toISOString()).toBe(at.toISOString());
  });

  it('EXECUTION_REQUESTED → FAILED on FAILURE', () => {
    const conversion = createConversion();
    conversion.markFundsReserved();
    conversion.markExecutionRequested('exec-001');
    conversion.applyExecutionResult('FAILURE', new Date(), 'simulated_failure');
    expect(conversion.status).toBe('FAILED');
    expect(conversion.failureReason).toBe('simulated_failure');
  });

  it('EXECUTION_REQUESTED → REQUIRES_RECONCILIATION on UNKNOWN', () => {
    const conversion = createConversion();
    conversion.markFundsReserved();
    conversion.markExecutionRequested('exec-001');
    conversion.applyExecutionResult('UNKNOWN', new Date());
    expect(conversion.status).toBe('REQUIRES_RECONCILIATION');
  });

  it('duplicate identical SUCCESS on COMPLETED is a no-op (idempotent)', () => {
    const conversion = createConversion();
    conversion.markFundsReserved();
    conversion.markExecutionRequested('exec-001');
    const at = new Date('2026-08-01T10:00:08.000Z');
    conversion.applyExecutionResult('SUCCESS', at);
    conversion.applyExecutionResult('SUCCESS', new Date());
    expect(conversion.status).toBe('COMPLETED');
    expect(conversion.completedAt?.toISOString()).toBe(at.toISOString());
  });

  it('conflicting FAILURE after COMPLETED is rejected (spec §4.1.7)', () => {
    const conversion = createConversion();
    conversion.markFundsReserved();
    conversion.markExecutionRequested('exec-001');
    conversion.applyExecutionResult('SUCCESS', new Date());
    expect(() => conversion.applyExecutionResult('FAILURE', new Date())).toThrow(
      ConflictingExecutionResultError,
    );
    expect(conversion.status).toBe('COMPLETED');
  });

  it('conflicting SUCCESS after FAILED is rejected', () => {
    const conversion = createConversion();
    conversion.markFundsReserved();
    conversion.markExecutionRequested('exec-001');
    conversion.applyExecutionResult('FAILURE', new Date(), 'simulated');
    expect(() => conversion.applyExecutionResult('SUCCESS', new Date())).toThrow(
      ConflictingExecutionResultError,
    );
    expect(conversion.status).toBe('FAILED');
  });

  it('duplicate FAILURE on FAILED is a no-op', () => {
    const conversion = createConversion();
    conversion.markFundsReserved();
    conversion.markExecutionRequested('exec-001');
    const at = new Date('2026-08-01T10:00:08.000Z');
    conversion.applyExecutionResult('FAILURE', at, 'simulated');
    conversion.applyExecutionResult('FAILURE', new Date(), 'other');
    expect(conversion.status).toBe('FAILED');
    expect(conversion.completedAt?.toISOString()).toBe(at.toISOString());
  });

  it('REQUIRES_RECONCILIATION → COMPLETED on SUCCESS (ops resolve)', () => {
    const conversion = createConversion();
    conversion.markFundsReserved();
    conversion.markExecutionRequested('exec-001');
    conversion.applyExecutionResult('UNKNOWN', new Date());
    const at = new Date('2026-08-01T10:00:09.000Z');
    conversion.applyExecutionResult('SUCCESS', at);
    expect(conversion.status).toBe('COMPLETED');
    expect(conversion.completedAt?.toISOString()).toBe(at.toISOString());
    expect(conversion.failureReason).toBeNull();
  });

  it('REQUIRES_RECONCILIATION → FAILED on FAILURE (ops resolve)', () => {
    const conversion = createConversion();
    conversion.markFundsReserved();
    conversion.markExecutionRequested('exec-001');
    conversion.applyExecutionResult('UNKNOWN', new Date());
    conversion.applyExecutionResult('FAILURE', new Date(), 'venue_rejected');
    expect(conversion.status).toBe('FAILED');
    expect(conversion.failureReason).toBe('venue_rejected');
  });

  it('duplicate UNKNOWN on REQUIRES_RECONCILIATION is a no-op', () => {
    const conversion = createConversion();
    conversion.markFundsReserved();
    conversion.markExecutionRequested('exec-001');
    conversion.applyExecutionResult('UNKNOWN', new Date());
    conversion.applyExecutionResult('UNKNOWN', new Date());
    expect(conversion.status).toBe('REQUIRES_RECONCILIATION');
  });

  it('rejects empty exchangeExecutionId', () => {
    const conversion = createConversion();
    conversion.markFundsReserved();
    expect(() => conversion.markExecutionRequested('   ')).toThrow(/exchangeExecutionId/);
  });

  it('rejects zero source/target amounts and same-asset pairs', () => {
    expect(() =>
      Conversion.create({
        id: ConversionId.of(randomUUID()),
        quoteId: QuoteId.of(randomUUID()),
        userId: UserId.of('user-123'),
        sourceAmount: Money.of('0', USDT),
        targetAmount: Money.of('0.00161', BTC),
        createdAt: new Date(),
      }),
    ).toThrow(/source amount/);

    expect(() =>
      Conversion.create({
        id: ConversionId.of(randomUUID()),
        quoteId: QuoteId.of(randomUUID()),
        userId: UserId.of('user-123'),
        sourceAmount: Money.of('100', USDT),
        targetAmount: Money.of('1', USDT),
        createdAt: new Date(),
      }),
    ).toThrow(/must differ/);
  });

  it('reconstitute restores snapshot fields', () => {
    const id = ConversionId.of(randomUUID());
    const quoteId = QuoteId.of(randomUUID());
    const createdAt = new Date('2026-08-01T10:00:05.000Z');
    const conversion = Conversion.reconstitute({
      id,
      quoteId,
      userId: UserId.of('user-123'),
      sourceAmount: Money.of('100', USDT),
      targetAmount: Money.of('0.00161', BTC),
      status: 'FUNDS_RESERVED',
      exchangeExecutionId: null,
      createdAt,
      completedAt: null,
      failureReason: null,
    });
    expect(conversion.status).toBe('FUNDS_RESERVED');
    expect(conversion.id.equals(id)).toBe(true);
    expect(conversion.quoteId.equals(quoteId)).toBe(true);
  });
});
