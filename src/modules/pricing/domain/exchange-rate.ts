import Decimal from 'decimal.js';
import '../../shared/domain/decimal-config';
import { Asset } from '../../shared/domain/asset';

/**
 * Units of `targetAsset` per 1 unit of `sourceAsset`. Immutable; never uses JS number.
 */
export class ExchangeRate {
  private readonly rate: Decimal;

  private constructor(
    public readonly sourceAsset: Asset,
    public readonly targetAsset: Asset,
    rate: Decimal,
  ) {
    this.rate = rate;
  }

  static of(sourceAsset: Asset, targetAsset: Asset, rate: Decimal.Value): ExchangeRate {
    if (sourceAsset.equals(targetAsset)) {
      throw new Error('ExchangeRate source and target assets must differ');
    }
    const decimal = new Decimal(rate);
    if (!decimal.isFinite() || decimal.isNegative() || decimal.isZero()) {
      throw new Error(`Exchange rate must be a finite positive number, got "${rate.toString()}"`);
    }
    return new ExchangeRate(sourceAsset, targetAsset, decimal);
  }

  toDecimal(): Decimal {
    return this.rate;
  }

  toString(): string {
    // Preserve significant digits; do not force a fixed scale (rates like 0.0000161).
    return this.rate.toFixed();
  }
}
