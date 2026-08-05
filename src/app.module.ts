import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';
import { SharedModule } from './modules/shared/shared.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { ConversionModule } from './modules/conversion/conversion.module';

const CORRELATION_ID_HEADER = 'x-correlation-id';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
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
            const correlationId =
              (Array.isArray(existing) ? existing[0] : existing) ?? randomUUID();
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
              'req.headers.cookie',
              'req.headers["idempotency-key"]',
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
