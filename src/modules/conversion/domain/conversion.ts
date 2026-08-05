import { Money } from '../../shared/domain/money';
import { UserId } from '../../shared/domain/user-id';
import { QuoteId } from '../../pricing/domain/quote-id';
import { ConversionId } from './conversion-id';

export type ConversionStatus =
  | 'CREATED'
  | 'FUNDS_RESERVED'
  | 'EXECUTION_REQUESTED'
  | 'COMPLETED'
  | 'FAILED'
  | 'REQUIRES_RECONCILIATION';

export type ExecutionOutcome = 'SUCCESS' | 'FAILURE' | 'UNKNOWN';

export class InvalidConversionTransitionError extends Error {
  constructor(from: ConversionStatus, action: string) {
    super(`Cannot ${action} conversion in status ${from}`);
    this.name = 'InvalidConversionTransitionError';
  }
}

export class ConflictingExecutionResultError extends Error {
  constructor(conversionId: ConversionId, current: ConversionStatus, incoming: ExecutionOutcome) {
    super(
      `Conflicting execution result ${incoming} for conversion ${conversionId.toString()} ` +
        `already in terminal status ${current}`,
    );
    this.name = 'ConflictingExecutionResultError';
  }
}

export interface ConversionSnapshot {
  id: ConversionId;
  quoteId: QuoteId;
  userId: UserId;
  sourceAmount: Money;
  targetAmount: Money;
  status: ConversionStatus;
  exchangeExecutionId: string | null;
  createdAt: Date;
  completedAt: Date | null;
  failureReason: string | null;
}

const TERMINAL: ReadonlySet<ConversionStatus> = new Set([
  'COMPLETED',
  'FAILED',
  'REQUIRES_RECONCILIATION',
]);

/**
 * Conversion aggregate — lifecycle only. Wallet mutations are coordinated by the
 * application layer (Wallet ≠ Conversion aggregate; see plan ADRs).
 *
 * Accept TX path: CREATED → FUNDS_RESERVED (same transaction).
 * Feature 4 advances FUNDS_RESERVED → EXECUTION_REQUESTED → terminal states.
 */
export class Conversion {
  private constructor(
    public readonly id: ConversionId,
    public readonly quoteId: QuoteId,
    public readonly userId: UserId,
    public readonly sourceAmount: Money,
    public readonly targetAmount: Money,
    private currentStatus: ConversionStatus,
    private exchangeExecutionIdValue: string | null,
    public readonly createdAt: Date,
    private completedAtValue: Date | null,
    private failureReasonValue: string | null,
  ) {
    if (sourceAmount.asset.equals(targetAmount.asset)) {
      throw new Error('Conversion source and target assets must differ');
    }
  }

  static create(params: {
    id: ConversionId;
    quoteId: QuoteId;
    userId: UserId;
    sourceAmount: Money;
    targetAmount: Money;
    createdAt: Date;
  }): Conversion {
    if (params.sourceAmount.isZero) {
      throw new Error('Conversion source amount must be positive');
    }
    if (params.targetAmount.isZero) {
      throw new Error('Conversion target amount must be positive');
    }
    return new Conversion(
      params.id,
      params.quoteId,
      params.userId,
      params.sourceAmount,
      params.targetAmount,
      'CREATED',
      null,
      params.createdAt,
      null,
      null,
    );
  }

  static reconstitute(snapshot: ConversionSnapshot): Conversion {
    return new Conversion(
      snapshot.id,
      snapshot.quoteId,
      snapshot.userId,
      snapshot.sourceAmount,
      snapshot.targetAmount,
      snapshot.status,
      snapshot.exchangeExecutionId,
      snapshot.createdAt,
      snapshot.completedAt,
      snapshot.failureReason,
    );
  }

  get status(): ConversionStatus {
    return this.currentStatus;
  }

  get exchangeExecutionId(): string | null {
    return this.exchangeExecutionIdValue;
  }

  get completedAt(): Date | null {
    return this.completedAtValue;
  }

  get failureReason(): string | null {
    return this.failureReasonValue;
  }

  get isTerminal(): boolean {
    return TERMINAL.has(this.currentStatus);
  }

  /** After wallet reserve succeeds inside the accept transaction. */
  markFundsReserved(): void {
    if (this.currentStatus !== 'CREATED') {
      throw new InvalidConversionTransitionError(this.currentStatus, 'markFundsReserved');
    }
    this.currentStatus = 'FUNDS_RESERVED';
  }

  /** After outbox event has been published (Feature 4 publisher / or when marking execution requested). */
  markExecutionRequested(exchangeExecutionId: string): void {
    if (this.currentStatus !== 'FUNDS_RESERVED') {
      throw new InvalidConversionTransitionError(this.currentStatus, 'markExecutionRequested');
    }
    if (!exchangeExecutionId.trim()) {
      throw new Error('exchangeExecutionId must not be empty');
    }
    this.exchangeExecutionIdValue = exchangeExecutionId;
    this.currentStatus = 'EXECUTION_REQUESTED';
  }

  /**
   * Apply a simulated (or real) exchange result. Idempotent for duplicate identical
   * outcomes on a terminal state; conflicting outcomes throw (spec §4.1.7).
   */
  applyExecutionResult(outcome: ExecutionOutcome, at: Date, reason?: string): void {
    if (this.currentStatus === 'REQUIRES_RECONCILIATION') {
      if (outcome === 'UNKNOWN') {
        return; // duplicate unknown — still waiting for ops
      }
      if (outcome === 'SUCCESS') {
        this.currentStatus = 'COMPLETED';
        this.completedAtValue = at;
        this.failureReasonValue = null;
        return;
      }
      if (outcome === 'FAILURE') {
        this.currentStatus = 'FAILED';
        this.completedAtValue = at;
        this.failureReasonValue = reason ?? 'execution_failed';
        return;
      }
    }

    if (this.isTerminal) {
      const expected: ExecutionOutcome =
        this.currentStatus === 'COMPLETED'
          ? 'SUCCESS'
          : this.currentStatus === 'FAILED'
            ? 'FAILURE'
            : 'UNKNOWN';
      if (outcome === expected) {
        return; // duplicate identical result — no-op
      }
      throw new ConflictingExecutionResultError(this.id, this.currentStatus, outcome);
    }

    if (this.currentStatus !== 'EXECUTION_REQUESTED') {
      throw new InvalidConversionTransitionError(this.currentStatus, 'applyExecutionResult');
    }

    if (outcome === 'SUCCESS') {
      this.currentStatus = 'COMPLETED';
      this.completedAtValue = at;
      this.failureReasonValue = null;
      return;
    }
    if (outcome === 'FAILURE') {
      this.currentStatus = 'FAILED';
      this.completedAtValue = at;
      this.failureReasonValue = reason ?? 'execution_failed';
      return;
    }
    // UNKNOWN / timeout — no wallet mutation until reconciled
    this.currentStatus = 'REQUIRES_RECONCILIATION';
    this.failureReasonValue = reason ?? 'execution_unknown';
  }
}
