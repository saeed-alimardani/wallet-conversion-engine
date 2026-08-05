import { Quote } from '../quote';
import { QuoteId } from '../quote-id';

export interface QuoteRepository {
  save(quote: Quote): Promise<void>;
  findById(id: QuoteId): Promise<Quote | null>;

  /**
   * Atomically persist acceptance: `UPDATE ... WHERE status = 'ACTIVE' AND expires_at >= now`.
   * Returns the updated quote, or null if zero rows matched (already accepted, expired, or missing).
   * Domain `quote.accept(now)` must have been called first so in-memory state matches.
   */
  saveAccepted(quote: Quote, now: Date): Promise<Quote | null>;
}
