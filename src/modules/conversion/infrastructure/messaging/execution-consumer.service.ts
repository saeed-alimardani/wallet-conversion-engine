import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConsumeMessage } from 'amqplib';
import { ProcessConversionExecutionUseCase } from '../../application/process-conversion-execution.use-case';
import { ConversionExecutionRequestedPayload } from '../../domain/outbox-message';
import { CONVERSION_EXECUTION_ROUTING_KEY } from './rabbitmq.constants';
import { RabbitMqConnection } from './rabbitmq.connection';

@Injectable()
export class ExecutionConsumerService implements OnModuleInit {
  private readonly logger = new Logger(ExecutionConsumerService.name);
  private readonly autoStart: boolean;

  constructor(
    private readonly rabbit: RabbitMqConnection,
    private readonly config: ConfigService,
    private readonly processExecution: ProcessConversionExecutionUseCase,
  ) {
    this.autoStart = this.config.get<string>('EXECUTION_CONSUMER_ENABLED', 'true') !== 'false';
  }

  async onModuleInit(): Promise<void> {
    if (!this.rabbit.isEnabled || !this.autoStart) {
      this.logger.warn('Execution consumer auto-start disabled');
      return;
    }
    await this.rabbit.consume(CONVERSION_EXECUTION_ROUTING_KEY, (msg) => this.handleMessage(msg));
    this.logger.log({
      msg: 'execution_consumer_started',
      queue: CONVERSION_EXECUTION_ROUTING_KEY,
    });
  }

  /** Exposed for tests that publish/consume without the background listener. */
  async handlePayload(payload: ConversionExecutionRequestedPayload): Promise<void> {
    await this.processExecution.execute(payload);
  }

  private async handleMessage(msg: ConsumeMessage): Promise<void> {
    const payload = JSON.parse(msg.content.toString('utf8')) as ConversionExecutionRequestedPayload;
    if (payload.eventType !== 'ConversionExecutionRequested' || !payload.eventId) {
      throw new Error('Invalid ConversionExecutionRequested payload');
    }
    this.logger.log({
      msg: 'execution_event_received',
      eventId: payload.eventId,
      conversionId: payload.conversionId,
      userId: payload.userId,
    });
    await this.processExecution.execute(payload);
  }
}
