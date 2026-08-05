import { ExecutionOutcome } from '../conversion';

/**
 * Port for the simulated (or real) external exchange. Spec §11.
 * Implementations must treat `clientOrderId` as an idempotency key — a timeout
 * retry must not create a second distinct order without checking prior status.
 */
export interface ExecuteConversionCommand {
  /** Unique client order id — we use the outbox eventId. */
  clientOrderId: string;
  conversionId: string;
  userId: string;
  sourceAsset: string;
  targetAsset: string;
  sourceAmount: string;
  targetAmount: string;
}

export interface ExecutionResult {
  outcome: ExecutionOutcome;
  externalReference?: string;
  reason?: string;
}

export interface ExchangeExecutionPort {
  execute(command: ExecuteConversionCommand): Promise<ExecutionResult>;
}
