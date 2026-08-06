import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

type ErrorMessage = string | string[];

interface ErrorEnvelope {
  statusCode: number;
  errorCode: string;
  message: ErrorMessage;
  correlationId?: string;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    if (response.headersSent) {
      return;
    }

    const envelope = this.toEnvelope(exception, request);
    const log = {
      msg: 'http_request_failed',
      method: request.method,
      route: this.routeLabel(request),
      statusCode: envelope.statusCode,
      errorCode: envelope.errorCode,
      correlationId: envelope.correlationId,
      operationResult: 'failure',
      ...(envelope.statusCode >= 500 && exception instanceof Error
        ? {
            errorName: exception.name,
            // Keep call sites for diagnosis without logging the exception message,
            // which can contain SQL values or other sensitive infrastructure details.
            stack: exception.stack?.split(/\r?\n/).slice(1).join('\n'),
          }
        : {}),
    };
    if (envelope.statusCode >= 500) {
      this.logger.error(log);
    } else {
      this.logger.warn(log);
    }
    response.status(envelope.statusCode).json(envelope);
  }

  private toEnvelope(exception: unknown, request: Request): ErrorEnvelope {
    const correlationId = this.correlationId(request);
    if (!(exception instanceof HttpException)) {
      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        errorCode: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error',
        ...(correlationId ? { correlationId } : {}),
      };
    }

    const statusCode = exception.getStatus();
    const raw = exception.getResponse();
    const body =
      typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : undefined;
    const rawMessage = body?.message;
    const message: ErrorMessage =
      typeof rawMessage === 'string' ||
      (Array.isArray(rawMessage) && rawMessage.every((item) => typeof item === 'string'))
        ? rawMessage
        : typeof raw === 'string'
          ? raw
          : exception.message || 'Request failed';
    const explicitCode = body?.errorCode;
    const errorCode =
      typeof explicitCode === 'string'
        ? explicitCode
        : statusCode === 400 && Array.isArray(message)
          ? 'VALIDATION_ERROR'
          : this.defaultErrorCode(statusCode);

    return {
      statusCode,
      errorCode,
      message,
      ...(correlationId ? { correlationId } : {}),
    };
  }

  private correlationId(request: Request): string | undefined {
    const value: unknown = (request as Request & { id?: unknown }).id;
    return typeof value === 'string' ? value : undefined;
  }

  private routeLabel(request: Request): string {
    const path = (request.route as { path?: unknown } | undefined)?.path;
    return typeof path === 'string' ? `${request.baseUrl}${path}` : 'unmatched';
  }

  private defaultErrorCode(statusCode: number): string {
    const name: unknown = HttpStatus[statusCode];
    return typeof name === 'string' ? name : 'HTTP_ERROR';
  }
}
