import { USDT, BTC, Asset } from '../../shared/domain/asset';
import { FakePricingProvider, UnsupportedAssetPairError } from './fake-pricing.provider';
import { Money } from '../../shared/domain/money';

describe('FakePricingProvider', () => {
  const provider = new FakePricingProvider();

  it('returns the deterministic USDT->BTC rate from the spec example', () => {
    const rate = provider.getRate(USDT, BTC);
    expect(rate.toString()).toBe('0.0000161');
    expect(Money.of('100', USDT).convert(rate.toDecimal(), BTC).toString()).toBe('0.00161000');
  });

  it('is deterministic across repeated calls (no randomness)', () => {
    const a = provider.getRate(USDT, BTC).toString();
    const b = provider.getRate(USDT, BTC).toString();
    expect(a).toBe(b);
  });

  it('throws for an unsupported asset pair', () => {
    const eth = Asset.register('ETH', 18);
    expect(() => provider.getRate(USDT, eth)).toThrow(UnsupportedAssetPairError);
  });
});
