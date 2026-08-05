/**
 * Abstraction over identifier generation so aggregates never depend on a concrete
 * ID scheme (uuid, ulid, DB sequence, ...) — only on this interface.
 */
export interface IdGenerator {
  generate(): string;
}
