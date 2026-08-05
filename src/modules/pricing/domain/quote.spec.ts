import { randomUUID } from 'crypto';
import { Money } from '../../shared/domain/money';
import { USDT, BTC } from '../../shared/domain/asset';
import { UserId } from '../../shared/domain/user-id';
import { ExchangeRate } from './exchange-rate';
import { QuoteId } from './quote-id';
import {
  Quote,
  QuoteAlreadyAcceptedError,
  QuoteExpiredError,
  InvalidQuoteError,
  QUOTE_TTL_SECONDS,
} from './quote';

function makeQuote(overrides?: { createdAt?: Date; sourceAmount?: string }): Quote {
  const createdAt = overrides?.createdAt ?? new Date('2026-08-01T10:00:00.000Z');
  return Quote.create({
    id: QuoteId.of(randomUUID()),
    userId: UserId.of('user-123'),
    sourceAmount: Money.of(overrides?.sourceAmount ?? '100', USDT),
    rate: ExchangeRate.of(USDT, BTC, '0.0000161'),
    createdAt,
  });
}

describe('Quote', () => {
  describe('create', () => {
    it('creates an ACTIVE quote with 20s TTL and the spec example target amount', () => {
      const createdAt = new Date('2026-08-01T10:00:00.000Z');
      const quote = makeQuote({ createdAt });

      expect(quote.status).toBe('ACTIVE');
      expect(quote.statusAt(createdAt)).toBe('ACTIVE');
      expect(quote.sourceAmount.toString()).toBe('100.000000');
      expect(quote.targetAmount.toString()).toBe('0.00161000');
      expect(quote.rate.toString()).toBe('0.0000161');
      expect(quote.expiresAt.toISOString()).toBe('2026-08-01T10:00:20.000Z');
      expect(quote.acceptedAt).toBeNull();
      expect(QUOTE_TTL_SECONDS).toBe(20);
    });

    it('rejects zero source amount', () => {
      expect(() => makeQuote({ sourceAmount: '0' })).toThrow(InvalidQuoteError);
    });

    it('rejects same-asset rate via ExchangeRate', () => {
      expect(() => ExchangeRate.of(USDT, USDT, '1')).toThrow(/must differ/);
    });
  });

  describe('expiry (spec §4.1.1)', () => {
    it('surfaces EXPIRED via statusAt after expiresAt', () => {
      const createdAt = new Date('2026-08-01T10:00:00.000Z');
      const quote = makeQuote({ createdAt });
      const afterExpiry = new Date('2026-08-01T10:00:21.000Z');

      expect(quote.isExpired(afterExpiry)).toBe(true);
      expect(quote.statusAt(afterExpiry)).toBe('EXPIRED');
      // Stored status remains ACTIVE until accept() or a sweeper — EXPIRED is derived.
      expect(quote.status).toBe('ACTIVE');
    });

    it('rejects accept after expiry', () => {
      const createdAt = new Date('2026-08-01T10:00:00.000Z');
      const quote = makeQuote({ createdAt });
      const afterExpiry = new Date('2026-08-01T10:00:21.000Z');

      expect(() => quote.accept(afterExpiry)).toThrow(QuoteExpiredError);
      expect(quote.status).toBe('ACTIVE');
      expect(quote.acceptedAt).toBeNull();
    });

    it('allows accept at exactly expiresAt (inclusive window end)', () => {
      const createdAt = new Date('2026-08-01T10:00:00.000Z');
      const quote = makeQuote({ createdAt });
      const atExpiry = new Date('2026-08-01T10:00:20.000Z');

      quote.accept(atExpiry);
      expect(quote.status).toBe('ACCEPTED');
      expect(quote.acceptedAt?.toISOString()).toBe(atExpiry.toISOString());
    });
  });

  describe('single accept (spec §4.1.2)', () => {
    it('accepts an ACTIVE quote once and sets acceptedAt', () => {
      const createdAt = new Date('2026-08-01T10:00:00.000Z');
      const quote = makeQuote({ createdAt });
      const acceptedAt = new Date('2026-08-01T10:00:05.000Z');

      quote.accept(acceptedAt);

      expect(quote.status).toBe('ACCEPTED');
      expect(quote.statusAt(acceptedAt)).toBe('ACCEPTED');
      expect(quote.acceptedAt?.toISOString()).toBe(acceptedAt.toISOString());
    });

    it('rejects a second accept', () => {
      const quote = makeQuote();
      const t1 = new Date('2026-08-01T10:00:05.000Z');
      const t2 = new Date('2026-08-01T10:00:06.000Z');

      quote.accept(t1);
      expect(() => quote.accept(t2)).toThrow(QuoteAlreadyAcceptedError);
      expect(quote.acceptedAt?.toISOString()).toBe(t1.toISOString());
    });
  });

  describe('reconstitute', () => {
    it('rebuilds an ACCEPTED quote with acceptedAt', () => {
      const id = QuoteId.of(randomUUID());
      const acceptedAt = new Date('2026-08-01T10:00:05.000Z');
      const quote = Quote.reconstitute({
        id,
        userId: UserId.of('user-123'),
        sourceAmount: Money.of('100', USDT),
        targetAmount: Money.of('0.00161', BTC),
        rate: ExchangeRate.of(USDT, BTC, '0.0000161'),
        createdAt: new Date('2026-08-01T10:00:00.000Z'),
        expiresAt: new Date('2026-08-01T10:00:20.000Z'),
        status: 'ACCEPTED',
        acceptedAt,
      });

      expect(quote.id.equals(id)).toBe(true);
      expect(quote.status).toBe('ACCEPTED');
      expect(quote.acceptedAt?.toISOString()).toBe(acceptedAt.toISOString());
    });
  });
});
