import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { HealthController } from './presentation/health/health.controller';
import { SystemClock } from './infrastructure/system-clock';
import { UuidIdGenerator } from './infrastructure/uuid-id-generator';
import { MetricsService } from './infrastructure/metrics/metrics.service';
import { MetricsController } from './infrastructure/metrics/metrics.controller';
import { HttpMetricsInterceptor } from './infrastructure/metrics/http-metrics.interceptor';
import { CLOCK, ID_GENERATOR } from './tokens';
import { ApiExceptionFilter } from './presentation/http/api-exception.filter';

/**
 * Shared kernel: cross-cutting ports (Clock, IdGenerator), metrics, and infrastructure
 * (Prisma) reused by the pricing/wallet/conversion bounded contexts.
 */
@Global()
@Module({
  imports: [PrismaModule],
  controllers: [HealthController, MetricsController],
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidIdGenerator },
    MetricsService,
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
  exports: [CLOCK, ID_GENERATOR, MetricsService],
})
export class SharedModule {}
