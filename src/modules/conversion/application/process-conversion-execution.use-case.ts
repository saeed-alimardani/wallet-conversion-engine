import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { CLOCK } from '../../shared/tokens';
import { Clock } from '../../shared/domain/ports/clock.port';
import { Asset } from '../../shared/domain/asset';
import { Money } from '../../shared/domain/money';
import { UserId } from '../../shared/domain/user-id';
import { MetricsService } from '../../shared/infrastructure/metrics/metrics.service';
import { WalletAccount } from '../../wallet/domain/wallet-account';
import { WalletRepository } from '../../wallet/domain/ports/wallet-repository.port';
import {
  ConflictingExecutionResultError,
  Conversion,
  ExecutionOutcome,
} from '../domain/conversion';
import { ConversionId } from '../domain/conversion-id';
import { ConversionExecutionRequestedPayload } from '../domain/outbox-message';
import { ExchangeExecutionPort } from '../domain/ports/exchange-execution.port';
import { ConversionRepository } from '../domain/ports/conversion-repository.port';
import { ProcessedMessageRepository } from '../domain/ports/processed-message-repository.port';
import { UnitOfWork, UnitOfWorkContext } from '../domain/ports/unit-of-work.port';
import {
  CONVERSION_REPOSITORY,
  EXCHANGE_EXECUTION,
  PROCESSED_MESSAGE_REPOSITORY,
  UNIT_OF_WORK,
} from '../tokens';

/**
 * Idempotent consumer handler for ConversionExecutionRequested.
 *
 * 1. Fast-path skip if event_id already in processed_messages
 * 2. Advance FUNDS_RESERVED → EXECUTION_REQUESTED (exchangeExecutionId = eventId)
 * 3. Call fake exchange (memoized by clientOrderId = eventId)
 * 4. In one TX: claim processed_messages, settle/release wallet, persist conversion
 */
@Injectable()
export class ProcessConversionExecutionUseCase {
  private readonly logger = new Logger(ProcessConversionExecutionUseCase.name);

  constructor(
    @Inject(PROCESSED_MESSAGE_REPOSITORY)
    private readonly processedMessages: ProcessedMessageRepository,
    @Inject(CONVERSION_REPOSITORY) private readonly conversions: ConversionRepository,
    @Inject(EXCHANGE_EXECUTION) private readonly exchange: ExchangeExecutionPort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly metrics: MetricsService,
  ) {}

  async execute(payload: ConversionExecutionRequestedPayload): Promise<void> {
    const started = process.hrtime.bigint();
    const eventId = payload.eventId;
    const conversionId = ConversionId.of(payload.conversionId);

    if (await this.processedMessages.exists(eventId)) {
      this.metrics.executionRetryTotal.inc();
      this.metrics.eventProcessingDurationSeconds.observe(
        { outcome: 'replay' },
        Number(process.hrtime.bigint() - started) / 1e9,
      );
      this.logger.log({
        msg: 'execution_event_already_processed',
        eventId,
        conversionId: payload.conversionId,
        operationResult: 'replay',
      });
      return;
    }

    const conversion = await this.conversions.findById(conversionId);
    if (!conversion) {
      throw new Error(`Conversion ${payload.conversionId} not found for event ${eventId}`);
    }

    if (conversion.isTerminal) {
      await this.processedMessages.tryRecord(
        eventId,
        payload.conversionId,
        this.outcomeFromStatus(conversion),
      );
      this.metrics.executionRetryTotal.inc();
      this.metrics.eventProcessingDurationSeconds.observe(
        { outcome: 'repaired' },
        Number(process.hrtime.bigint() - started) / 1e9,
      );
      this.logger.warn({
        msg: 'execution_event_terminal_without_processed_marker',
        eventId,
        conversionId: payload.conversionId,
        status: conversion.status,
        operationResult: 'repaired',
      });
      return;
    }

    if (conversion.status === 'FUNDS_RESERVED') {
      conversion.markExecutionRequested(eventId);
      await this.conversions.save(conversion);
    } else if (conversion.status !== 'EXECUTION_REQUESTED') {
      throw new Error(
        `Conversion ${payload.conversionId} in unexpected status ${conversion.status} for execution`,
      );
    }

    const executionResult = await this.exchange.execute({
      clientOrderId: eventId,
      conversionId: payload.conversionId,
      userId: payload.userId,
      sourceAsset: payload.sourceAsset,
      targetAsset: payload.targetAsset,
      sourceAmount: payload.sourceAmount,
      targetAmount: payload.targetAmount,
    });

    const now = this.clock.now();
    let settled = false;

    await this.uow.execute(async (ctx) => {
      const claimed = await ctx.processedMessages.tryRecord(
        eventId,
        payload.conversionId,
        executionResult.outcome,
      );
      if (!claimed) {
        this.metrics.executionRetryTotal.inc();
        return;
      }

      const fresh = await ctx.conversions.findById(conversionId);
      if (!fresh) {
        throw new Error(`Conversion ${payload.conversionId} disappeared during settlement`);
      }

      if (fresh.status === 'FUNDS_RESERVED') {
        fresh.markExecutionRequested(eventId);
      }

      const previousStatus = fresh.status;
      await this.applyOutcome(ctx, fresh, executionResult.outcome, now, executionResult.reason);
      settled = previousStatus !== 'COMPLETED' && previousStatus !== 'FAILED';
    });

    if (settled) {
      if (executionResult.outcome === 'SUCCESS') {
        this.metrics.conversionCompletedTotal.inc();
      } else if (executionResult.outcome === 'FAILURE') {
        this.metrics.conversionFailedTotal.inc();
      }
    }

    this.metrics.eventProcessingDurationSeconds.observe(
      { outcome: executionResult.outcome.toLowerCase() },
      Number(process.hrtime.bigint() - started) / 1e9,
    );

    this.logger.log({
      msg: 'execution_event_processed',
      eventId,
      conversionId: payload.conversionId,
      userId: payload.userId,
      operationResult: executionResult.outcome === 'SUCCESS' ? 'success' : 'failure',
      errorCode: executionResult.reason,
    });
  }

  private async applyOutcome(
    ctx: UnitOfWorkContext,
    conversion: Conversion,
    outcome: ExecutionOutcome,
    now: Date,
    reason?: string,
  ): Promise<void> {
    const { wallets, conversions } = ctx;
    const userId = conversion.userId;
    const sourceAsset = conversion.sourceAmount.asset;
    const targetAsset = conversion.targetAmount.asset;

    try {
      if (outcome === 'SUCCESS') {
        if (conversion.status === 'COMPLETED') {
          return;
        }
        if (
          conversion.status === 'EXECUTION_REQUESTED' ||
          conversion.status === 'REQUIRES_RECONCILIATION'
        ) {
          await wallets.commitReservation(userId, sourceAsset, conversion.sourceAmount);
          await this.ensureTargetWallet(wallets, userId, targetAsset);
          await wallets.credit(userId, targetAsset, conversion.targetAmount);
        }
        conversion.applyExecutionResult('SUCCESS', now);
        await conversions.save(conversion);
        return;
      }

      if (outcome === 'FAILURE') {
        if (conversion.status === 'FAILED') {
          return;
        }
        if (
          conversion.status === 'EXECUTION_REQUESTED' ||
          conversion.status === 'REQUIRES_RECONCILIATION'
        ) {
          await wallets.release(userId, sourceAsset, conversion.sourceAmount);
        }
        conversion.applyExecutionResult('FAILURE', now, reason);
        await conversions.save(conversion);
        return;
      }

      conversion.applyExecutionResult('UNKNOWN', now, reason);
      await conversions.save(conversion);
    } catch (error: unknown) {
      if (error instanceof ConflictingExecutionResultError) {
        this.logger.error({
          msg: 'conflicting_execution_result',
          eventId: conversion.exchangeExecutionId,
          conversionId: conversion.id.toString(),
          errorCode: 'CONFLICTING_EXECUTION_RESULT',
          operationResult: 'failure',
          err: error.message,
        });
        return;
      }
      throw error;
    }
  }

  private async ensureTargetWallet(
    wallets: WalletRepository,
    userId: UserId,
    asset: Asset,
  ): Promise<void> {
    const existing = await wallets.findByUserAndAsset(userId, asset);
    if (existing) {
      return;
    }
    await wallets.create(WalletAccount.open(randomUUID(), userId, asset, Money.zero(asset)));
  }

  private outcomeFromStatus(conversion: Conversion): ExecutionOutcome {
    if (conversion.status === 'COMPLETED') {
      return 'SUCCESS';
    }
    if (conversion.status === 'FAILED') {
      return 'FAILURE';
    }
    return 'UNKNOWN';
  }
}
