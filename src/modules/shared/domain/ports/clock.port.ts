/**
 * Abstraction over "current time" so domain logic (e.g. quote expiry) is deterministic
 * and testable without faking global `Date`. The domain layer depends only on this
 * interface, never on `Date.now()` directly or on any framework.
 */
export interface Clock {
  now(): Date;
}
