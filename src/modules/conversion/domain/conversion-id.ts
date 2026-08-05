export class ConversionId {
  private constructor(public readonly value: string) {}

  static of(value: string): ConversionId {
    const trimmed = value?.trim();
    if (!trimmed) {
      throw new Error('ConversionId must not be empty');
    }
    return new ConversionId(trimmed);
  }

  equals(other: ConversionId): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
