import Decimal from 'decimal.js';
import './decimal-config';
import { Asset } from './asset';

/**
 * `Money` is an immutable value object pairing an exact `Decimal` amount with its `Asset`.
 *
 * Design rules (see docs/DECISIONS.md once written):
 * - JavaScript `number` is never used for amounts — decimal.js avoids IEEE-754 float
 *   drift (e.g. 0.1 + 0.2 !== 0.3) which is unacceptable for monetary values.
 * - Arithmetic (`add`/`subtract`/comparisons) is only defined between `Money` of the
 *   *same* asset; mixing assets throws immediately rather than silently producing a
 *   meaningless number.
 * - Cross-asset conversion (quote pricing) is a distinct, explicit operation
 *   (`convert`) that always rounds down to the target asset's scale — it is not
 *   reachable via `add`/`subtract`.
 * - At the API/DB boundary, amounts are represented as decimal strings (Postgres
 *   `NUMERIC`), never floats.
 */
export class Money {
  private readonly amount: Decimal;

  private constructor(
    amount: Decimal,
    public readonly asset: Asset,
  ) {
    this.amount = amount;
  }

  static zero(asset: Asset): Money {
    return new Money(new Decimal(0), asset);
  }

  static of(amount: Decimal.Value, asset: Asset): Money {
    const decimal = new Decimal(amount);
    if (!decimal.isFinite()) {
      throw new Error(`Money amount must be finite, got "${amount.toString()}"`);
    }
    if (decimal.isNegative()) {
      throw new Error(`Money amount must not be negative, got "${decimal.toString()}"`);
    }
    if (decimal.decimalPlaces() > asset.scale) {
      throw new Error(
        `Amount "${decimal.toString()}" exceeds ${asset.code} scale of ${asset.scale} decimal places`,
      );
    }
    return new Money(decimal, asset);
  }

  get isZero(): boolean {
    return this.amount.isZero();
  }

  isPositive(): boolean {
    return !this.amount.isZero();
  }

  private assertSameAsset(other: Money, operation: string): void {
    if (!this.asset.equals(other.asset)) {
      throw new Error(
        `Cannot ${operation} Money of different assets: ${this.asset.code} and ${other.asset.code}`,
      );
    }
  }

  add(other: Money): Money {
    this.assertSameAsset(other, 'add');
    return new Money(this.amount.plus(other.amount), this.asset);
  }

  /** Throws if the result would be negative — callers must check `isGreaterThanOrEqual` first when that matters. */
  subtract(other: Money): Money {
    this.assertSameAsset(other, 'subtract');
    const result = this.amount.minus(other.amount);
    if (result.isNegative()) {
      throw new Error(
        `Subtracting ${other.toString()} from ${this.toString()} would produce a negative ${this.asset.code} amount`,
      );
    }
    return new Money(result, this.asset);
  }

  isGreaterThanOrEqual(other: Money): boolean {
    this.assertSameAsset(other, 'compare');
    return this.amount.greaterThanOrEqualTo(other.amount);
  }

  isLessThan(other: Money): boolean {
    this.assertSameAsset(other, 'compare');
    return this.amount.lessThan(other.amount);
  }

  equals(other: Money): boolean {
    return this.asset.equals(other.asset) && this.amount.equals(other.amount);
  }

  /**
   * Converts this amount into `targetAsset` using `rate` (units of targetAsset per unit of
   * this asset), rounding DOWN to the target asset's scale. Rounding down is deliberate:
   * a conversion must never fabricate value the exchange did not actually deliver.
   */
  convert(rate: Decimal.Value, targetAsset: Asset): Money {
    const rateDecimal = new Decimal(rate);
    if (!rateDecimal.isFinite() || rateDecimal.isNegative() || rateDecimal.isZero()) {
      throw new Error(`Exchange rate must be a finite positive number, got "${rate.toString()}"`);
    }
    const converted = this.amount
      .times(rateDecimal)
      .toDecimalPlaces(targetAsset.scale, Decimal.ROUND_DOWN);
    return new Money(converted, targetAsset);
  }

  toDecimal(): Decimal {
    return this.amount;
  }

  toString(): string {
    return this.amount.toFixed(this.asset.scale);
  }

  toJSON(): string {
    return this.toString();
  }
}
