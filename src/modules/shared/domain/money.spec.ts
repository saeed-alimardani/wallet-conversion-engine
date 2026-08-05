import fc from 'fast-check';
import Decimal from 'decimal.js';
import { Money } from './money';
import { Asset, USDT, BTC } from './asset';

/** Generates amounts with at most `asset.scale` decimal places, by construction (no rounding). */
function arbitraryAmount(asset: Asset, maxMajorUnits = 1_000_000): fc.Arbitrary<Decimal> {
  const scaleFactor = new Decimal(10).pow(asset.scale);
  return fc
    .bigInt({ min: 0n, max: BigInt(maxMajorUnits) * 10n ** BigInt(asset.scale) })
    .map((minorUnits) => new Decimal(minorUnits.toString()).dividedBy(scaleFactor));
}

describe('Money', () => {
  describe('construction', () => {
    it('rejects amounts with more decimal places than the asset scale', () => {
      // USDT scale is 6; 7 fractional digits must be rejected.
      expect(() => Money.of('1.1234567', USDT)).toThrow(/exceeds USDT scale/);
    });

    it('rejects negative amounts', () => {
      expect(() => Money.of('-1', USDT)).toThrow(/must not be negative/);
    });

    it('rejects non-finite amounts', () => {
      expect(() => Money.of(Infinity, USDT)).toThrow();
    });

    it('accepts an amount at exactly the asset scale', () => {
      expect(Money.of('1.123456', USDT).toString()).toBe('1.123456');
    });
  });

  describe('floating-point safety', () => {
    it('does not exhibit the classic 0.1 + 0.2 float drift', () => {
      const a = Money.of('0.1', USDT);
      const b = Money.of('0.2', USDT);
      expect(a.add(b).toString()).toBe('0.300000');
    });
  });

  describe('same-asset arithmetic (property-based)', () => {
    it('addition is exact for arbitrary same-asset amounts', () => {
      fc.assert(
        fc.property(arbitraryAmount(USDT), arbitraryAmount(USDT), (a, b) => {
          const sum = Money.of(a, USDT).add(Money.of(b, USDT));
          expect(sum.toDecimal().toString()).toBe(a.plus(b).toString());
        }),
      );
    });

    it('reserve-then-release restores the original amount (add then subtract identity)', () => {
      fc.assert(
        fc.property(arbitraryAmount(USDT), arbitraryAmount(USDT), (a, b) => {
          const original = Money.of(a, USDT);
          const delta = Money.of(b, USDT);
          const restored = original.add(delta).subtract(delta);
          expect(restored.equals(original)).toBe(true);
        }),
      );
    });

    it('subtracting more than is available throws instead of going negative', () => {
      fc.assert(
        fc.property(arbitraryAmount(USDT, 1000), (a) => {
          const balance = Money.of(a, USDT);
          const tooMuch = balance.add(Money.of('0.000001', USDT));
          expect(() => balance.subtract(tooMuch)).toThrow(/negative/);
        }),
      );
    });
  });

  describe('cross-asset safety (property-based)', () => {
    it('never allows arithmetic or comparison between different assets', () => {
      fc.assert(
        fc.property(arbitraryAmount(USDT), arbitraryAmount(BTC), (a, b) => {
          const usdt = Money.of(a, USDT);
          const btc = Money.of(b, BTC);
          expect(() => usdt.add(btc)).toThrow(/different assets/);
          expect(() => usdt.subtract(btc)).toThrow(/different assets/);
          expect(() => usdt.isGreaterThanOrEqual(btc)).toThrow(/different assets/);
        }),
      );
    });
  });

  describe('convert', () => {
    it('rounds down to the target asset scale and never fabricates value', () => {
      fc.assert(
        fc.property(arbitraryAmount(USDT, 100_000), (amount) => {
          const usdt = Money.of(amount, USDT);
          const rate = '0.0000161'; // USDT -> BTC, matches spec example
          const btc = usdt.convert(rate, BTC);

          expect(btc.asset.equals(BTC)).toBe(true);
          expect(btc.toDecimal().decimalPlaces()).toBeLessThanOrEqual(BTC.scale);
          expect(btc.toDecimal().lessThanOrEqualTo(amount.times(rate))).toBe(true);
        }),
      );
    });

    it('matches the spec example exactly (100 USDT -> 0.00161 BTC)', () => {
      const usdt = Money.of('100', USDT);
      const btc = usdt.convert('0.0000161', BTC);
      expect(btc.toString()).toBe('0.00161000');
    });

    it('rejects a zero or negative rate', () => {
      const usdt = Money.of('100', USDT);
      expect(() => usdt.convert('0', BTC)).toThrow(/positive/);
      expect(() => usdt.convert('-1', BTC)).toThrow(/positive/);
    });
  });
});
