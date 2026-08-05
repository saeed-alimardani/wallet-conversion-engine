/**
 * `Asset` is a self-registering value object identifying a digital asset (e.g. USDT, BTC)
 * and the number of decimal places ("scale") it is quoted/stored with.
 *
 * Registration is deliberately explicit and process-wide (not DB-backed) because the set
 * of tradable assets for this challenge is small and static; a real system would back this
 * with an asset-metadata table, but the domain contract (`Asset.of` / `Asset.register`)
 * would stay the same.
 */
export class Asset {
  private static readonly registry = new Map<string, Asset>();

  private constructor(
    public readonly code: string,
    public readonly scale: number,
  ) {}

  static register(code: string, scale: number): Asset {
    const normalized = Asset.normalize(code);
    const existing = Asset.registry.get(normalized);
    if (existing) {
      if (existing.scale !== scale) {
        throw new Error(
          `Asset ${normalized} is already registered with scale ${existing.scale}, cannot re-register with scale ${scale}`,
        );
      }
      return existing;
    }
    if (!Number.isInteger(scale) || scale < 0) {
      throw new Error(`Asset scale must be a non-negative integer, got ${scale} for ${normalized}`);
    }
    const asset = new Asset(normalized, scale);
    Asset.registry.set(normalized, asset);
    return asset;
  }

  static of(code: string): Asset {
    const normalized = Asset.normalize(code);
    const asset = Asset.registry.get(normalized);
    if (!asset) {
      throw new Error(
        `Unknown asset code: "${code}". Register it via Asset.register() before use.`,
      );
    }
    return asset;
  }

  static isRegistered(code: string): boolean {
    return Asset.registry.has(Asset.normalize(code));
  }

  private static normalize(code: string): string {
    const normalized = code.trim().toUpperCase();
    if (normalized.length === 0) {
      throw new Error('Asset code must not be empty');
    }
    return normalized;
  }

  equals(other: Asset): boolean {
    return this.code === other.code;
  }

  toString(): string {
    return this.code;
  }
}

// Well-known assets for this challenge's scope (spec example flow: USDT -> BTC).
// Additional assets can be registered the same way without touching Money/Asset.
export const USDT = Asset.register('USDT', 6);
export const BTC = Asset.register('BTC', 8);
