import { ExecutionOutcome } from '../conversion';

export interface ProcessedMessageRepository {
  exists(eventId: string): Promise<boolean>;

  /**
   * Insert a processed marker. Returns true if this caller won the insert;
   * false if the event was already processed (unique constraint / ON CONFLICT).
   */
  tryRecord(eventId: string, conversionId: string, outcome: ExecutionOutcome): Promise<boolean>;
}
