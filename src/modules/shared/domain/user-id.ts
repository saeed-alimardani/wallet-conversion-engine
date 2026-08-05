/**
 * Identifies a user. Deliberately opaque (no assumptions about format) since user
 * identity/auth is explicitly out of scope for this challenge (spec §20) — the API
 * simply trusts the `userId` supplied by the caller.
 */
export class UserId {
  private constructor(public readonly value: string) {}

  static of(value: string): UserId {
    const trimmed = value?.trim();
    if (!trimmed) {
      throw new Error('UserId must not be empty');
    }
    return new UserId(trimmed);
  }

  equals(other: UserId): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
