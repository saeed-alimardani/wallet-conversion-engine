import { Asset } from '../../../shared/domain/asset';
import { ExchangeRate } from '../exchange-rate';

/**
 * Port for obtaining an exchange rate. Domain/application depend on this interface;
 * the fake deterministic adapter lives in infrastructure (no real exchange, spec §11).
 */
export interface PricingProvider {
  getRate(sourceAsset: Asset, targetAsset: Asset): ExchangeRate;
}
