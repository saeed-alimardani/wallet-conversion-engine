import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExecutionOutcome } from '../domain/conversion';
import {
  ExchangeExecutionPort,
  ExecuteConversionCommand,
  ExecutionResult,
} from '../domain/ports/exchange-execution.port';

export type FakeExchangeMode = ExecutionOutcome;

/**
 * Deterministic fake exchange (no real venue). Results are memoized by
 * `clientOrderId` so a timeout/redelivery retry returns the same outcome instead
 * of creating a second logical order (spec §11).
 *
 * Default mode from `FAKE_EXCHANGE_MODE` (SUCCESS | FAILURE | UNKNOWN).
 * Tests may call `setMode` / `setModeForClientOrder` to force paths.
 */
@Injectable()
export class FakeExchangeAdapter implements ExchangeExecutionPort {
  private readonly logger = new Logger(FakeExchangeAdapter.name);
  private defaultMode: FakeExchangeMode;
  private readonly perOrderMode = new Map<string, FakeExchangeMode>();
  private readonly resultsByClientOrderId = new Map<string, ExecutionResult>();

  constructor(config: ConfigService) {
    const configured = (config.get<string>('FAKE_EXCHANGE_MODE') ?? 'SUCCESS').toUpperCase();
    this.defaultMode = this.parseMode(configured);
  }

  setMode(mode: FakeExchangeMode): void {
    this.defaultMode = mode;
  }

  setModeForClientOrder(clientOrderId: string, mode: FakeExchangeMode): void {
    this.perOrderMode.set(clientOrderId, mode);
  }

  clearMemoizedResults(): void {
    this.resultsByClientOrderId.clear();
  }

  execute(command: ExecuteConversionCommand): Promise<ExecutionResult> {
    const existing = this.resultsByClientOrderId.get(command.clientOrderId);
    if (existing) {
      this.logger.log({
        msg: 'fake_exchange_idempotent_replay',
        eventId: command.clientOrderId,
        conversionId: command.conversionId,
        outcome: existing.outcome,
      });
      return Promise.resolve(existing);
    }

    const mode = this.perOrderMode.get(command.clientOrderId) ?? this.defaultMode;
    const result = this.buildResult(command, mode);
    this.resultsByClientOrderId.set(command.clientOrderId, result);

    this.logger.log({
      msg: 'fake_exchange_executed',
      eventId: command.clientOrderId,
      conversionId: command.conversionId,
      outcome: result.outcome,
      operationResult: result.outcome === 'SUCCESS' ? 'success' : 'failure',
    });

    return Promise.resolve(result);
  }

  private buildResult(command: ExecuteConversionCommand, mode: FakeExchangeMode): ExecutionResult {
    if (mode === 'SUCCESS') {
      return {
        outcome: 'SUCCESS',
        externalReference: `fake-${command.clientOrderId}`,
      };
    }
    if (mode === 'FAILURE') {
      return {
        outcome: 'FAILURE',
        reason: 'simulated_exchange_failure',
        externalReference: `fake-${command.clientOrderId}`,
      };
    }
    return {
      outcome: 'UNKNOWN',
      reason: 'simulated_exchange_timeout',
      externalReference: `fake-${command.clientOrderId}`,
    };
  }

  private parseMode(value: string): FakeExchangeMode {
    if (value === 'FAILURE' || value === 'UNKNOWN' || value === 'SUCCESS') {
      return value;
    }
    return 'SUCCESS';
  }
}
