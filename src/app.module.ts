import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';
import { SharedModule } from './modules/shared/shared.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { ConversionModule } from './modules/conversion/conversion.module';
import { validateEnvironment } from './config/environment';

const CORRELATION_ID_HEADER = 'x-correlation-id';
const SAFE_CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function correlationIdFromHeader(value: string | string[] | undefined): string {
  const candidate = (Array.isArray(value) ? value[0] : value)?.trim();
  return candidate && SAFE_CORRELATION_ID.test(candidate) ? candidate : randomUUID();
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }),
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: {
          level: config.get<string>('LOG_LEVEL', 'info'),
          // Reuse an inbound correlation id if the caller supplied one, otherwise mint one.
          // Echoed back on the response so clients can correlate their own logs.
          genReqId: (req: IncomingMessage, res: ServerResponse) => {
            const existing = req.headers[CORRELATION_ID_HEADER];
            const correlationId = correlationIdFromHeader(existing);
            res.setHeader(CORRELATION_ID_HEADER, correlationId);
            return correlationId;
          },
          customProps: (req: IncomingMessage) => ({
            correlationId: (req as unknown as { id: string }).id,
          }),
          // Never log credentials/secrets/full sensitive payloads (spec observability requirement).
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers["proxy-authorization"]',
              'req.headers.cookie',
              'req.headers["idempotency-key"]',
              'req.headers["x-api-key"]',
              'res.headers["set-cookie"]',
            ],
            censor: '[REDACTED]',
          },
          transport:
            config.get<string>('NODE_ENV') !== 'production'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
        },
      }),
    }),
    SharedModule,
    WalletModule,
    PricingModule,
    ConversionModule,
  ],
})
export class AppModule {}
