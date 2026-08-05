import {
  ConflictException,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { MetricsService } from '../../shared/infrastructure/metrics/metrics.service';
import { AcceptQuoteSuccessBody, AcceptQuoteUseCase } from '../application/accept-quote.use-case';

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
    @Param('quoteId') quoteId: string,
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
      this.metrics.quoteAcceptanceTotal.inc();
      this.logger.info({
        msg: 'quote_accept_idempotent_replay',
        quoteId,
        conversionId:
          typeof result.body === 'object' && result.body !== null && 'conversionId' in result.body
            ? String((result.body as { conversionId: string }).conversionId)
            : undefined,
        operationResult: 'replay',
      });
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
