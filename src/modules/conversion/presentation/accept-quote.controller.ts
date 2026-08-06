import {
  BadRequestException,
  ConflictException,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { MetricsService } from '../../shared/infrastructure/metrics/metrics.service';
import { AcceptQuoteSuccessBody, AcceptQuoteUseCase } from '../application/accept-quote.use-case';

const QUOTE_ID_PIPE = new ParseUUIDPipe({
  version: '4',
  exceptionFactory: () =>
    new BadRequestException({
      errorCode: 'INVALID_QUOTE_ID',
      message: 'quoteId must be a valid UUID',
    }),
});

@Controller('quotes')
export class AcceptQuoteController {
  constructor(
    private readonly acceptQuote: AcceptQuoteUseCase,
    private readonly metrics: MetricsService,
    @InjectPinoLogger(AcceptQuoteController.name)
    private readonly logger: PinoLogger,
  ) {}

  @Post(':quoteId/accept')
  @HttpCode(HttpStatus.CREATED)
  async accept(
    @Param('quoteId', QUOTE_ID_PIPE) quoteId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<AcceptQuoteSuccessBody> {
    const result = await this.acceptQuote.execute({
      quoteId,
      idempotencyKey: idempotencyKey ?? '',
    });

    if (result.kind === 'created') {
      this.metrics.quoteAcceptanceTotal.inc();
      this.logger.info({
        msg: 'quote_accepted',
        quoteId: result.body.quoteId,
        conversionId: result.body.conversionId,
        userId: result.body.userId,
        operationResult: 'success',
      });
      return result.body;
    }

    if (result.kind === 'replay') {
      this.logger.info({
        msg: 'quote_accept_idempotent_replay',
        quoteId,
        conversionId:
          typeof result.body === 'object' && result.body !== null && 'conversionId' in result.body
            ? String((result.body as { conversionId: string }).conversionId)
            : undefined,
        operationResult: 'replay',
      });
      if (result.statusCode >= 200 && result.statusCode < 300) {
        if (!isAcceptQuoteSuccessBody(result.body)) {
          throw new InternalServerErrorException({
            errorCode: 'INVALID_IDEMPOTENCY_RESPONSE',
            message: 'Stored idempotency response is invalid',
          });
        }
        this.metrics.quoteAcceptanceTotal.inc();
        return result.body;
      }
      throw new HttpException(result.body as object, result.statusCode);
    }

    this.metrics.quoteAcceptanceFailedTotal.inc({ error_code: result.errorCode });
    if (result.errorCode === 'INSUFFICIENT_AVAILABLE_BALANCE') {
      this.metrics.walletReservationConflictTotal.inc();
    }

    this.logger.warn({
      msg: 'quote_accept_failed',
      quoteId,
      errorCode: result.errorCode,
      operationResult: 'failure',
    });

    if (result.statusCode === 404) {
      throw new NotFoundException({
        errorCode: result.errorCode,
        message: result.message,
      });
    }
    if (result.statusCode === 409) {
      throw new ConflictException({
        errorCode: result.errorCode,
        message: result.message,
      });
    }
    throw new HttpException(
      { errorCode: result.errorCode, message: result.message },
      result.statusCode,
    );
  }
}

function isAcceptQuoteSuccessBody(value: unknown): value is AcceptQuoteSuccessBody {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return [
    'conversionId',
    'quoteId',
    'userId',
    'status',
    'sourceAsset',
    'targetAsset',
    'sourceAmount',
    'targetAmount',
    'createdAt',
  ].every((key) => typeof body[key] === 'string');
}
