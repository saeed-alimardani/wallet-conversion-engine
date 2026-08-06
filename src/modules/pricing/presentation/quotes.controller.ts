import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { MetricsService } from '../../shared/infrastructure/metrics/metrics.service';
import { CreateQuoteUseCase, InvalidQuoteRequestError } from '../application/create-quote.use-case';
import { Quote } from '../domain/quote';
import { CreateQuoteDto } from './dto/create-quote.dto';

export interface QuoteResponse {
  quoteId: string;
  sourceAsset: string;
  targetAsset: string;
  sourceAmount: string;
  targetAmount: string;
  rate: string;
  expiresAt: string;
  status: string;
}

@Controller('quotes')
export class QuotesController {
  constructor(
    private readonly createQuote: CreateQuoteUseCase,
    private readonly metrics: MetricsService,
    @InjectPinoLogger(QuotesController.name)
    private readonly logger: PinoLogger,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: CreateQuoteDto): Promise<QuoteResponse> {
    try {
      const quote = await this.createQuote.execute(body);
      this.metrics.quoteCreatedTotal.inc();
      this.logger.info({
        msg: 'quote_created',
        quoteId: quote.id.toString(),
        userId: quote.userId.toString(),
        operationResult: 'success',
      });
      return this.toResponse(quote);
    } catch (error: unknown) {
      if (error instanceof InvalidQuoteRequestError) {
        throw new BadRequestException({
          errorCode: 'INVALID_QUOTE_REQUEST',
          message: error.message,
        });
      }
      throw error;
    }
  }

  private toResponse(quote: Quote): QuoteResponse {
    return {
      quoteId: quote.id.toString(),
      sourceAsset: quote.sourceAsset.code,
      targetAsset: quote.targetAsset.code,
      sourceAmount: trimTrailingZeros(quote.sourceAmount.toString()),
      targetAmount: trimTrailingZeros(quote.targetAmount.toString()),
      rate: quote.rate.toString(),
      expiresAt: quote.expiresAt.toISOString().replace(/\.000Z$/, 'Z'),
      status: quote.statusAt(quote.createdAt),
    };
  }
}

function trimTrailingZeros(decimal: string): string {
  if (!decimal.includes('.')) {
    return decimal;
  }
  return decimal.replace(/\.?0+$/, '');
}
