export type IdempotencyLookup =
  | { kind: 'missing' }
  | { kind: 'in-progress'; requestHash: string }
  | {
      kind: 'completed';
      requestHash: string;
      responseStatus: number;
      responseBody: unknown;
      conversionId: string | null;
    };

export interface IdempotencyRepository {
  find(scope: string, key: string): Promise<IdempotencyLookup>;

  /**
   * Insert a claimed key. Returns true if this caller won the insert;
   * false if the key already existed (unique constraint).
   */
  tryBegin(scope: string, key: string, requestHash: string): Promise<boolean>;

  complete(
    scope: string,
    key: string,
    response: { responseStatus: number; responseBody: unknown; conversionId: string },
  ): Promise<void>;
}
