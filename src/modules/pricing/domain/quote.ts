import { Asset } from '../../shared/domain/asset';
import { Money } from '../../shared/domain/money';
import { UserId } from '../../shared/domain/user-id';
import { ExchangeRate } from './exchange-rate';
import { QuoteId } from './quote-id';

export type QuoteStatus = 'ACTIVE' | 'ACCEPTED' | 'EXPIRED';

export const QUOTE_TTL_SECONDS = 20;

export class QuoteExpiredError extends Error {
  constructor(quoteId: QuoteId) {
    super(`Quote ${quoteId.toString()} has expired and cannot be accepted`);
    this.name = 'QuoteExpiredError';
  }
}

export class QuoteAlreadyAcceptedError extends Error {
  constructor(quoteId: QuoteId) {
    super(`Quote ${quoteId.toString()} has already been accepted`);
    this.name = 'QuoteAlreadyAcceptedError';
  }
}

export class InvalidQuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidQuoteError';
  }
}

export interface QuoteSnapshot {
  id: QuoteId;
  userId: UserId;
  sourceAmount: Money;
  targetAmount: Money;
  rate: ExchangeRate;
  createdAt: Date;
  expiresAt: Date;
  status: QuoteStatus;
  acceptedAt: Date | null;
}

/**
 * Quote aggregate: short-lived price lock for a conversion.
 *
 * Status stored as ACTIVE or ACCEPTED. EXPIRED is derived when `now > expiresAt`
 * while still ACTIVE — avoids a background sweeper for a 20s TTL. `accept(now)`
 * enforces invariants §4.1.1 and §4.1.2 (not expired, accept once).
 */
export class Quote {
  private constructor(
    public readonly id: QuoteId,
    public readonly userId: UserId,
    public readonly sourceAmount: Money,
    public readonly targetAmount: Money,
    public readonly rate: ExchangeRate,
    public readonly createdAt: Date,
    public readonly expiresAt: Date,
    private currentStatus: QuoteStatus,
    private acceptedAtValue: Date | null,
  ) {
    if (currentStatus === 'EXPIRED') {
      throw new InvalidQuoteError('EXPIRED is a derived status and must not be persisted');
    }
    if (currentStatus === 'ACCEPTED' && acceptedAtValue === null) {
      throw new InvalidQuoteError('ACCEPTED quote must have acceptedAt');
    }
    if (currentStatus === 'ACTIVE' && acceptedAtValue !== null) {
      throw new InvalidQuoteError('ACTIVE quote must not have acceptedAt');
    }
    if (
      !sourceAmount.asset.equals(rate.sourceAsset) ||
      !targetAmount.asset.equals(rate.targetAsset)
    ) {
      throw new InvalidQuoteError('Quote amounts must match the exchange rate asset pair');
    }
    if (sourceAmount.isZero) {
      throw new InvalidQuoteError('Quote source amount must be positive');
    }
    if (expiresAt.getTime() <= createdAt.getTime()) {
      throw new InvalidQuoteError('Quote expiresAt must be after createdAt');
    }
  }

  static create(params: {
    id: QuoteId;
    userId: UserId;
    sourceAmount: Money;
    rate: ExchangeRate;
    createdAt: Date;
    ttlSeconds?: number;
  }): Quote {
    const ttl = params.ttlSeconds ?? QUOTE_TTL_SECONDS;
    if (!Number.isInteger(ttl) || ttl <= 0) {
      throw new InvalidQuoteError(`Quote TTL must be a positive integer, got ${ttl}`);
    }
    if (!params.sourceAmount.asset.equals(params.rate.sourceAsset)) {
      throw new InvalidQuoteError(
        `Source amount asset ${params.sourceAmount.asset.code} does not match rate source ${params.rate.sourceAsset.code}`,
      );
    }
    if (params.sourceAmount.isZero) {
      throw new InvalidQuoteError('Quote source amount must be positive');
    }

    const targetAmount = params.sourceAmount.convert(
      params.rate.toDecimal(),
      params.rate.targetAsset,
    );
    if (targetAmount.isZero) {
      throw new InvalidQuoteError(
        `Quoted target amount rounds to zero for ${params.sourceAmount.toString()} at rate ${params.rate.toString()}`,
      );
    }

    const expiresAt = new Date(params.createdAt.getTime() + ttl * 1000);
    return new Quote(
      params.id,
      params.userId,
      params.sourceAmount,
      targetAmount,
      params.rate,
      params.createdAt,
      expiresAt,
      'ACTIVE',
      null,
    );
  }

  static reconstitute(snapshot: QuoteSnapshot): Quote {
    return new Quote(
      snapshot.id,
      snapshot.userId,
      snapshot.sourceAmount,
      snapshot.targetAmount,
      snapshot.rate,
      snapshot.createdAt,
      snapshot.expiresAt,
      snapshot.status === 'EXPIRED' ? 'ACTIVE' : snapshot.status,
      snapshot.acceptedAt,
    );
  }

  get status(): QuoteStatus {
    return this.currentStatus;
  }

  get acceptedAt(): Date | null {
    return this.acceptedAtValue;
  }

  get sourceAsset(): Asset {
    return this.sourceAmount.asset;
  }

  get targetAsset(): Asset {
    return this.targetAmount.asset;
  }

  isExpired(now: Date): boolean {
    return this.currentStatus === 'ACTIVE' && now.getTime() > this.expiresAt.getTime();
  }

  /** Effective status for API responses: ACTIVE may surface as EXPIRED when past expiresAt. */
  statusAt(now: Date): QuoteStatus {
    if (this.currentStatus === 'ACCEPTED') {
      return 'ACCEPTED';
    }
    return this.isExpired(now) ? 'EXPIRED' : 'ACTIVE';
  }

  /**
   * Marks the quote accepted. Caller must pass the same clock used for expiry checks.
   * Sets `acceptedAt` for auditability (Feature 3 accept orchestration).
   */
  accept(now: Date): void {
    if (this.currentStatus === 'ACCEPTED') {
      throw new QuoteAlreadyAcceptedError(this.id);
    }
    if (this.isExpired(now)) {
      throw new QuoteExpiredError(this.id);
    }
    this.currentStatus = 'ACCEPTED';
    this.acceptedAtValue = now;
  }
}
