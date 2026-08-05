import { createHash } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, ID_GENERATOR } from '../../shared/tokens';
import { Clock } from '../../shared/domain/ports/clock.port';
import { IdGenerator } from '../../shared/domain/ports/id-generator.port';
import { QuoteId } from '../../pricing/domain/quote-id';
import { QuoteAlreadyAcceptedError, QuoteExpiredError } from '../../pricing/domain/quote';
import { Conversion } from '../domain/conversion';
import { ConversionId } from '../domain/conversion-id';
import { OutboxMessage } from '../domain/outbox-message';
import { IdempotencyRepository } from '../domain/ports/idempotency-repository.port';
import { UnitOfWork } from '../domain/ports/unit-of-work.port';
import { IDEMPOTENCY_REPOSITORY, UNIT_OF_WORK } from '../tokens';

export interface AcceptQuoteCommand {
  quoteId: string;
  idempotencyKey: string;
}

export interface AcceptQuoteSuccessBody {
  conversionId: string;
  quoteId: string;
  userId: string;
  status: string;
  sourceAsset: string;
  targetAsset: string;
  sourceAmount: string;
  targetAmount: string;
  createdAt: string;
}

export type AcceptQuoteResult =
  | { kind: 'created'; statusCode: 201; body: AcceptQuoteSuccessBody }
  | { kind: 'replay'; statusCode: number; body: unknown }
  | { kind: 'error'; statusCode: number; errorCode: string; message: string };

/** Max time a concurrent same-key loser waits for the winner to complete (spec §9). */
const DEFAULT_IN_PROGRESS_WAIT_MS = 2000;
const DEFAULT_IN_PROGRESS_POLL_MS = 25;

function acceptScope(quoteId: string): string {
  return `POST:/quotes/${quoteId}/accept`;
}

function requestHash(quoteId: string): string {
  // Accept has no body; fingerprint the path identity so a reused key on a different
  // quoteId (different scope) is a separate record, and same scope+key always matches.
  return createHash('sha256').update(quoteId).digest('hex');
}

function trimTrailingZeros(decimal: string): string {
  if (!decimal.includes('.')) {
    return decimal;
  }
  return decimal.replace(/\.?0+$/, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

@Injectable()
export class AcceptQuoteUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(IDEMPOTENCY_REPOSITORY) private readonly idempotency: IdempotencyRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: AcceptQuoteCommand): Promise<AcceptQuoteResult> {
    const quoteIdValue = command.quoteId.trim();
    const idempotencyKey = command.idempotencyKey.trim();
    if (!quoteIdValue) {
      return {
        kind: 'error',
        statusCode: 400,
        errorCode: 'INVALID_QUOTE_ID',
        message: 'quoteId must not be empty',
      };
    }
    if (!idempotencyKey) {
      return {
        kind: 'error',
        statusCode: 400,
        errorCode: 'MISSING_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key header is required',
      };
    }

    const scope = acceptScope(quoteIdValue);
    const hash = requestHash(quoteIdValue);

    try {
      const result = await this.uow.execute(async (ctx) => {
        const began = await ctx.idempotency.tryBegin(scope, idempotencyKey, hash);
        if (!began) {
          const existing = await ctx.idempotency.find(scope, idempotencyKey);
          if (existing.kind === 'missing') {
            // Extremely unlikely race: unique conflict then row vanished
            return {
              kind: 'error' as const,
              statusCode: 409,
              errorCode: 'IDEMPOTENCY_RACE',
              message: 'Idempotency key conflict; retry the request',
            };
          }
          if (existing.requestHash !== hash) {
            return {
              kind: 'error' as const,
              statusCode: 409,
              errorCode: 'IDEMPOTENCY_KEY_REUSE',
              message: 'Idempotency-Key was already used with a different request fingerprint',
            };
          }
          if (existing.kind === 'in-progress') {
            return {
              kind: 'error' as const,
              statusCode: 409,
              errorCode: 'IDEMPOTENCY_IN_PROGRESS',
              message: 'A request with this Idempotency-Key is already in progress',
            };
          }
          return {
            kind: 'replay' as const,
            statusCode: existing.responseStatus,
            body: existing.responseBody,
          };
        }

        const quoteId = QuoteId.of(quoteIdValue);
        const now = this.clock.now();
        const quote = await ctx.quotes.findById(quoteId);
        if (!quote) {
          // Abort by throwing so the TX rolls back the idempotency claim — otherwise a
          // failed accept would poison the key. For 404 we intentionally roll back.
          throw new AcceptAbortedError({
            kind: 'error',
            statusCode: 404,
            errorCode: 'QUOTE_NOT_FOUND',
            message: `Quote ${quoteIdValue} was not found`,
          });
        }

        try {
          quote.accept(now);
        } catch (error: unknown) {
          if (error instanceof QuoteExpiredError) {
            throw new AcceptAbortedError({
              kind: 'error',
              statusCode: 409,
              errorCode: 'QUOTE_EXPIRED',
              message: error.message,
            });
          }
          if (error instanceof QuoteAlreadyAcceptedError) {
            throw new AcceptAbortedError({
              kind: 'error',
              statusCode: 409,
              errorCode: 'QUOTE_ALREADY_ACCEPTED',
              message: error.message,
            });
          }
          throw error;
        }

        const persistedQuote = await ctx.quotes.saveAccepted(quote, now);
        if (!persistedQuote) {
          throw new AcceptAbortedError({
            kind: 'error',
            statusCode: 409,
            errorCode: 'QUOTE_ACCEPT_CONFLICT',
            message: 'Quote could not be accepted (expired or already accepted concurrently)',
          });
        }

        const conversion = Conversion.create({
          id: ConversionId.of(this.ids.generate()),
          quoteId: quote.id,
          userId: quote.userId,
          sourceAmount: quote.sourceAmount,
          targetAmount: quote.targetAmount,
          createdAt: now,
        });
        // Persist CREATED before funds move (plan §9); same TX immediately advances after reserve.
        await ctx.conversions.save(conversion);

        const reservation = await ctx.wallets.reserve(
          quote.userId,
          quote.sourceAsset,
          quote.sourceAmount,
        );
        if (reservation.outcome === 'insufficient-or-conflict') {
          throw new AcceptAbortedError({
            kind: 'error',
            statusCode: 409,
            errorCode: 'INSUFFICIENT_AVAILABLE_BALANCE',
            message: `Insufficient available ${quote.sourceAsset.code} balance to reserve ${trimTrailingZeros(quote.sourceAmount.toString())}`,
          });
        }

        conversion.markFundsReserved();
        await ctx.conversions.save(conversion);

        const eventId = this.ids.generate();
        const outbox = OutboxMessage.createConversionExecutionRequested({
          id: eventId,
          createdAt: now,
          payload: {
            eventId,
            eventType: 'ConversionExecutionRequested',
            conversionId: conversion.id.toString(),
            userId: quote.userId.toString(),
            sourceAsset: quote.sourceAsset.code,
            targetAsset: quote.targetAsset.code,
            sourceAmount: trimTrailingZeros(quote.sourceAmount.toString()),
            targetAmount: trimTrailingZeros(quote.targetAmount.toString()),
            occurredAt: now.toISOString().replace(/\.000Z$/, 'Z'),
          },
        });
        await ctx.outbox.enqueue(outbox);

        const body: AcceptQuoteSuccessBody = {
          conversionId: conversion.id.toString(),
          quoteId: quote.id.toString(),
          userId: quote.userId.toString(),
          status: conversion.status,
          sourceAsset: quote.sourceAsset.code,
          targetAsset: quote.targetAsset.code,
          sourceAmount: trimTrailingZeros(quote.sourceAmount.toString()),
          targetAmount: trimTrailingZeros(quote.targetAmount.toString()),
          createdAt: conversion.createdAt.toISOString().replace(/\.000Z$/, 'Z'),
        };

        await ctx.idempotency.complete(scope, idempotencyKey, {
          responseStatus: 201,
          responseBody: body,
          conversionId: conversion.id.toString(),
        });

        return { kind: 'created' as const, statusCode: 201 as const, body };
      });

      // Concurrent same-key losers see in-progress inside the TX; wait *outside* the TX
      // (no long-held locks) until the winner completes, then replay the stored response.
      if (result.kind === 'error' && result.errorCode === 'IDEMPOTENCY_IN_PROGRESS') {
        const replay = await this.waitForIdempotentCompletion(scope, idempotencyKey, hash);
        if (replay) {
          return replay;
        }
      }

      return result;
    } catch (error: unknown) {
      if (error instanceof AcceptAbortedError) {
        return error.result;
      }
      throw error;
    }
  }

  /**
   * Polls the completed idempotency record outside any transaction so concurrent
   * duplicate accepts return the same logical 201 result (spec §9).
   */
  private async waitForIdempotentCompletion(
    scope: string,
    key: string,
    hash: string,
  ): Promise<Extract<AcceptQuoteResult, { kind: 'replay' }> | null> {
    const maxWaitMs = readPositiveIntEnv(
      'IDEMPOTENCY_IN_PROGRESS_WAIT_MS',
      DEFAULT_IN_PROGRESS_WAIT_MS,
    );
    const pollMs = Math.max(
      1,
      readPositiveIntEnv('IDEMPOTENCY_IN_PROGRESS_POLL_MS', DEFAULT_IN_PROGRESS_POLL_MS),
    );
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() <= deadline) {
      const existing = await this.idempotency.find(scope, key);
      if (existing.kind === 'completed') {
        if (existing.requestHash !== hash) {
          return null;
        }
        return {
          kind: 'replay',
          statusCode: existing.responseStatus,
          body: existing.responseBody,
        };
      }
      if (existing.kind === 'missing') {
        return null;
      }
      await sleep(pollMs);
    }

    return null;
  }
}

/**
 * Signals a business failure that must roll back the accept transaction
 * (including the idempotency claim) and be mapped to an HTTP error result.
 */
class AcceptAbortedError extends Error {
  constructor(readonly result: Extract<AcceptQuoteResult, { kind: 'error' }>) {
    super(result.message);
    this.name = 'AcceptAbortedError';
  }
}
