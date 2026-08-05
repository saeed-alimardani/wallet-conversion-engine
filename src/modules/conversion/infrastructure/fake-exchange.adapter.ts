import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Decimal from 'decimal.js';
import { PrismaService } from '../../shared/infrastructure/prisma/prisma.service';
import { ExecutionOutcome } from '../domain/conversion';
import {
  ExchangeExecutionPort,
  ExecuteConversionCommand,
  ExecutionResult,
} from '../domain/ports/exchange-execution.port';

export type FakeExchangeMode = ExecutionOutcome;

/**
 * Deterministic fake exchange (no real venue). Results are persisted by `clientOrderId`
 * so timeout/redelivery retries and process restarts return the same outcome instead of
 * creating a second logical order (spec §11).
 *
 * Default mode from `FAKE_EXCHANGE_MODE` (SUCCESS | FAILURE | UNKNOWN).
 * Tests may call `setMode` / `setModeForClientOrder` to force paths.
 */
@Injectable()
export class FakeExchangeAdapter implements ExchangeExecutionPort {
  private readonly logger = new Logger(FakeExchangeAdapter.name);
  private defaultMode: FakeExchangeMode;
  private readonly perOrderMode = new Map<string, FakeExchangeMode>();

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const configured = (config.get<string>('FAKE_EXCHANGE_MODE') ?? 'SUCCESS').toUpperCase();
    this.defaultMode = this.parseMode(configured);
  }

  setMode(mode: FakeExchangeMode): void {
    this.defaultMode = mode;
  }

  setModeForClientOrder(clientOrderId: string, mode: FakeExchangeMode): void {
    this.perOrderMode.set(clientOrderId, mode);
  }

  async execute(command: ExecuteConversionCommand): Promise<ExecutionResult> {
    const mode = this.perOrderMode.get(command.clientOrderId) ?? this.defaultMode;
    const proposed = this.buildResult(command, mode);
    const persisted = await this.prisma.fakeExchangeExecution.upsert({
      where: { clientOrderId: command.clientOrderId },
      update: {},
      create: {
        clientOrderId: command.clientOrderId,
        conversionId: command.conversionId,
        userId: command.userId,
        sourceAsset: command.sourceAsset,
        targetAsset: command.targetAsset,
        sourceAmount: command.sourceAmount,
        targetAmount: command.targetAmount,
        outcome: proposed.outcome,
        reason: proposed.reason,
        externalReference: proposed.externalReference!,
      },
    });
    this.assertSameCommand(command, persisted);

    const result: ExecutionResult = {
      outcome: this.parsePersistedOutcome(persisted.outcome),
      externalReference: persisted.externalReference,
      ...(persisted.reason === null ? {} : { reason: persisted.reason }),
    };
    const replayed =
      persisted.outcome !== proposed.outcome ||
      persisted.reason !== (proposed.reason ?? null) ||
      persisted.externalReference !== proposed.externalReference;
    if (replayed) {
      this.logger.log({
        msg: 'fake_exchange_idempotent_replay',
        eventId: command.clientOrderId,
        conversionId: command.conversionId,
        outcome: result.outcome,
      });
      return result;
    }

    this.logger.log({
      msg: 'fake_exchange_executed',
      eventId: command.clientOrderId,
      conversionId: command.conversionId,
      outcome: result.outcome,
      operationResult: result.outcome === 'SUCCESS' ? 'success' : 'failure',
    });

    return result;
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

  private parsePersistedOutcome(value: string): ExecutionOutcome {
    if (value === 'FAILURE' || value === 'UNKNOWN' || value === 'SUCCESS') {
      return value;
    }
    throw new Error(`Invalid persisted fake exchange outcome: ${value}`);
  }

  private assertSameCommand(
    command: ExecuteConversionCommand,
    persisted: {
      conversionId: string;
      userId: string;
      sourceAsset: string;
      targetAsset: string;
      sourceAmount: unknown;
      targetAmount: unknown;
    },
  ): void {
    const identityMatches =
      persisted.conversionId === command.conversionId &&
      persisted.userId === command.userId &&
      persisted.sourceAsset === command.sourceAsset &&
      persisted.targetAsset === command.targetAsset;
    const amountsMatch =
      new Decimal(String(persisted.sourceAmount)).equals(command.sourceAmount) &&
      new Decimal(String(persisted.targetAmount)).equals(command.targetAmount);
    if (!identityMatches || !amountsMatch) {
      throw new Error(
        `clientOrderId ${command.clientOrderId} was already used for a different execution command`,
      );
    }
  }
}
