import { Conversion } from '../conversion';
import { ConversionId } from '../conversion-id';

export interface ConversionRepository {
  save(conversion: Conversion): Promise<void>;
  findById(id: ConversionId): Promise<Conversion | null>;

  /**
   * Atomically advances an event-bound FUNDS_RESERVED row to EXECUTION_REQUESTED.
   * If another worker already changed the row, returns its latest state without overwriting it.
   */
  markExecutionRequestedIfFundsReserved(
    id: ConversionId,
    eventId: string,
  ): Promise<Conversion | null>;
}
