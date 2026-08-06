import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { Request, Response } from 'express';
import { MetricsService } from './metrics.service';

/**
 * Records `http_request_duration_seconds` with low-cardinality labels:
 * method, route template (not raw URL), status_code.
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const started = process.hrtime.bigint();

    return next.handle().pipe(
      tap({
        next: () => this.observe(req, res, started),
        error: (error: unknown) =>
          this.observe(req, res, started, error instanceof HttpException ? error.getStatus() : 500),
      }),
    );
  }

  private observe(
    req: Request,
    res: Response,
    started: bigint,
    statusCode = res.statusCode || 500,
  ): void {
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    const route = this.routeLabel(req);
    // Skip scraping /metrics itself to avoid feedback noise.
    if (route === '/metrics') {
      return;
    }
    this.metrics.httpRequestDurationSeconds.observe(
      {
        method: req.method,
        route,
        status_code: String(statusCode),
      },
      seconds,
    );
  }

  private routeLabel(req: Request): string {
    // Express route path when available (e.g. /quotes/:quoteId/accept), else path without query.
    const routePath = (req.route as { path?: string } | undefined)?.path;
    if (typeof routePath === 'string' && routePath.length > 0) {
      const base = typeof req.baseUrl === 'string' ? req.baseUrl : '';
      return `${base}${routePath}`;
    }
    return 'unmatched';
  }
}
