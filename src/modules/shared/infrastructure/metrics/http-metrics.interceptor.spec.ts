import { BadRequestException, CallHandler, ExecutionContext } from '@nestjs/common';
import { Request, Response } from 'express';
import { lastValueFrom, Observable, of, throwError } from 'rxjs';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';
import { MetricsService } from './metrics.service';

describe('HttpMetricsInterceptor', () => {
  let metrics: MetricsService;
  let interceptor: HttpMetricsInterceptor;

  beforeEach(() => {
    metrics = new MetricsService();
    interceptor = new HttpMetricsInterceptor(metrics);
  });

  it('uses a constant label for unmatched routes', async () => {
    const context = httpContext(
      { method: 'GET', path: '/missing/high-cardinality-id' },
      { statusCode: 404 },
    );

    await lastValueFrom(interceptor.intercept(context, handler(of(undefined))));

    const text = await metrics.metricsText();
    expect(text).toContain('route="unmatched"');
    expect(text).not.toContain('high-cardinality-id');
  });

  it('labels exceptions with their eventual HTTP status', async () => {
    const context = httpContext(
      {
        method: 'POST',
        baseUrl: '/quotes',
        route: { path: '/:quoteId/accept' },
      },
      { statusCode: 201 },
    );

    await expect(
      lastValueFrom(
        interceptor.intercept(
          context,
          handler(throwError(() => new BadRequestException('invalid'))),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    const text = await metrics.metricsText();
    expect(text).toContain('status_code="400"');
    expect(text).not.toContain('status_code="201"');
  });
});

function httpContext(request: Partial<Request>, response: Partial<Response>): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

function handler(stream: Observable<unknown>): CallHandler {
  return { handle: () => stream };
}
