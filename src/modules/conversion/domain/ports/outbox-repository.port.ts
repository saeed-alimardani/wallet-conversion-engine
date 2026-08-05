import { OutboxMessage } from '../outbox-message';

export interface OutboxRepository {
  enqueue(message: OutboxMessage): Promise<void>;

  /** Oldest unpublished outbox rows, up to `limit` (publisher batch). */
  findUnpublished(limit: number): Promise<OutboxMessage[]>;

  /** Mark a single outbox row published; no-op if already published. */
  markPublished(id: string, publishedAt: Date): Promise<void>;

  /** Count of unpublished outbox rows (for `outbox_pending_count` gauge). */
  countUnpublished(): Promise<number>;
}
