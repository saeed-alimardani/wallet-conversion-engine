import { Asset, USDT, BTC } from './asset';

describe('Asset', () => {
  it('registers well-known assets with the expected scale', () => {
    expect(USDT.code).toBe('USDT');
    expect(USDT.scale).toBe(6);
    expect(BTC.code).toBe('BTC');
    expect(BTC.scale).toBe(8);
  });

  it('returns the same instance for repeated registration with a matching scale', () => {
    const again = Asset.register('usdt', 6);
    expect(again).toBe(USDT);
  });

  it('throws when re-registering a known code with a different scale', () => {
    expect(() => Asset.register('USDT', 2)).toThrow(/already registered/);
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(Asset.of(' usdt ')).toBe(USDT);
  });

  it('throws for an unknown asset code', () => {
    expect(() => Asset.of('DOGE')).toThrow(/Unknown asset code/);
  });

  it('throws when registering with a negative or non-integer scale', () => {
    expect(() => Asset.register('FOO', -1)).toThrow(/non-negative integer/);
    expect(() => Asset.register('BAR', 1.5)).toThrow(/non-negative integer/);
  });

  it('reports registration status via isRegistered', () => {
    expect(Asset.isRegistered('USDT')).toBe(true);
    expect(Asset.isRegistered('NOPE')).toBe(false);
  });

  it('equals compares by code', () => {
    expect(USDT.equals(Asset.of('USDT'))).toBe(true);
    expect(USDT.equals(BTC)).toBe(false);
  });
});
