export class QuoteId {
  private constructor(public readonly value: string) {}

  static of(value: string): QuoteId {
    const trimmed = value?.trim();
    if (!trimmed) {
      throw new Error('QuoteId must not be empty');
    }
    return new QuoteId(trimmed);
  }

  equals(other: QuoteId): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
