import { ArgumentsHost, BadRequestException, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiExceptionFilter } from './api-exception.filter';

describe('ApiExceptionFilter', () => {
  let errorLog: jest.SpyInstance;

  beforeEach(() => {
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('hides unexpected exception details behind a stable 500 envelope', () => {
    const { host, status, json } = httpHost({ id: 'trace-123', method: 'GET' });

    new ApiExceptionFilter().catch(new Error('database password leaked'), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      statusCode: 500,
      errorCode: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
      correlationId: 'trace-123',
    });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('database password leaked');
  });

  it('normalizes class-validator errors without discarding their messages', () => {
    const { host, status, json } = httpHost({ method: 'POST' });
    const exception = new BadRequestException({
      statusCode: 400,
      message: ['sourceAmount must be a string'],
      error: 'Bad Request',
    });

    new ApiExceptionFilter().catch(exception, host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: ['sourceAmount must be a string'],
    });
  });
});

function httpHost(request: Partial<Request>): {
  host: ArgumentsHost;
  status: jest.Mock;
  json: jest.Mock;
} {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const response = { headersSent: false, status } as unknown as Response;
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
      getNext: () => undefined,
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}
