import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import {
  ConversionStatusResponse,
  GetConversionUseCase,
} from '../application/get-conversion.use-case';

const CONVERSION_ID_PIPE = new ParseUUIDPipe({
  version: '4',
  exceptionFactory: () =>
    new BadRequestException({
      errorCode: 'INVALID_CONVERSION_ID',
      message: 'conversionId must be a valid UUID',
    }),
});

@Controller('conversions')
export class ConversionsController {
  constructor(
    private readonly getConversion: GetConversionUseCase,
    @InjectPinoLogger(ConversionsController.name)
    private readonly logger: PinoLogger,
  ) {}

  @Get(':conversionId')
  async getById(
    @Param('conversionId', CONVERSION_ID_PIPE) conversionId: string,
  ): Promise<ConversionStatusResponse> {
    const result = await this.getConversion.execute(conversionId);

    if (result.kind === 'found') {
      this.logger.info({
        msg: 'conversion_queried',
        conversionId: result.body.conversionId,
        operationResult: 'success',
      });
      return result.body;
    }

    if (result.kind === 'invalid_id') {
      throw new BadRequestException({
        errorCode: 'INVALID_CONVERSION_ID',
        message: result.message,
      });
    }

    this.logger.warn({
      msg: 'conversion_not_found',
      conversionId,
      errorCode: 'CONVERSION_NOT_FOUND',
      operationResult: 'failure',
    });
    throw new NotFoundException({
      errorCode: 'CONVERSION_NOT_FOUND',
      message: `Conversion ${conversionId} was not found`,
    });
  }
}
