import { Injectable } from '@nestjs/common';
import { Asset } from '../../shared/domain/asset';
import { ExchangeRate } from '../domain/exchange-rate';
import { PricingProvider } from '../domain/ports/pricing-provider.port';

export class UnsupportedAssetPairError extends Error {
  constructor(source: Asset, target: Asset) {
    super(`No deterministic rate configured for ${source.code} -> ${target.code}`);
    this.name = 'UnsupportedAssetPairError';
  }
}

/**
 * Deterministic fake pricing — fixed rate table, no randomness, so tests and demos
 * are repeatable. Matches the challenge's worked example: 100 USDT -> 0.00161 BTC
 * at rate 0.0000161.
 */
@Injectable()
export class FakePricingProvider implements PricingProvider {
  private static readonly RATES: ReadonlyMap<string, string> = new Map([
    ['USDT->BTC', '0.0000161'],
    ['BTC->USDT', '62111.801242236'],
  ]);

  getRate(sourceAsset: Asset, targetAsset: Asset): ExchangeRate {
    const key = `${sourceAsset.code}->${targetAsset.code}`;
    const rate = FakePricingProvider.RATES.get(key);
    if (rate === undefined) {
      throw new UnsupportedAssetPairError(sourceAsset, targetAsset);
    }
    return ExchangeRate.of(sourceAsset, targetAsset, rate);
  }
}
