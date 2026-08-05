import Decimal from 'decimal.js';

let configured = false;

/**
 * Configures the global decimal.js instance used across the entire domain layer.
 *
 * Must run before any `Decimal`/`Money` instance is created. Imported (and therefore
 * executed) as a side effect by `money.ts`, so any module that imports `Money`
 * transitively gets a correctly configured `Decimal` before it can construct one.
 *
 * - precision: generous enough for chained conversions (amount * rate) without
 *   losing significant digits.
 * - rounding: bankers' rounding (ROUND_HALF_EVEN) avoids systematic bias when
 *   repeatedly rounding monetary values.
 * - toExpNeg/toExpPos: widened so small crypto amounts (e.g. 0.0000161 BTC) never
 *   render in exponential notation, which would break naive string parsing at the
 *   API/DB boundary.
 */
export function configureDecimal(): void {
  if (configured) {
    return;
  }
  Decimal.set({
    precision: 40,
    rounding: Decimal.ROUND_HALF_EVEN,
    toExpNeg: -60,
    toExpPos: 60,
  });
  configured = true;
}

configureDecimal();
