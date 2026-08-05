export type OutboxEventType = 'ConversionExecutionRequested';

export interface ConversionExecutionRequestedPayload {
  eventId: string;
  eventType: 'ConversionExecutionRequested';
  conversionId: string;
  userId: string;
  sourceAsset: string;
  targetAsset: string;
  sourceAmount: string;
  targetAmount: string;
  occurredAt: string;
}

/**
 * Outbox row written in the same TX as accept. Publishing (Feature 4) reads
 * unpublished rows; Feature 3 only persists them.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly eventType: OutboxEventType,
    public readonly aggregateId: string,
    public readonly payload: ConversionExecutionRequestedPayload,
    public readonly createdAt: Date,
    public readonly publishedAt: Date | null,
  ) {}

  static createConversionExecutionRequested(params: {
    id: string;
    payload: ConversionExecutionRequestedPayload;
    createdAt: Date;
  }): OutboxMessage {
    if (params.payload.eventType !== 'ConversionExecutionRequested') {
      throw new Error('Invalid outbox event type');
    }
    if (params.payload.eventId !== params.id) {
      throw new Error('Outbox message id must equal payload.eventId');
    }
    return new OutboxMessage(
      params.id,
      'ConversionExecutionRequested',
      params.payload.conversionId,
      params.payload,
      params.createdAt,
      null,
    );
  }

  get isPublished(): boolean {
    return this.publishedAt !== null;
  }
}
