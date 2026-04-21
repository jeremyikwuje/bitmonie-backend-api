import { AssetPair } from '@prisma/client';
import Decimal from 'decimal.js';
import { QuidaxProvider } from '@/providers/quidax/quidax.provider';

const CONFIG = { api_key: 'test_key', base_url: 'https://app.quidax.io/api/v1' };

const MOCK_TICKER_RESPONSE = {
  status: 'success',
  data: {
    btcngn: {
      ticker: { buy: '97000000.0', sell: '98000000.0' },
    },
    usdtngn: {
      ticker: { buy: '1590.0', sell: '1610.0' },
    },
  },
};

function make_provider() {
  return new QuidaxProvider(CONFIG);
}

function mock_ok(body: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(body),
  });
}

afterEach(() => jest.resetAllMocks());

describe('QuidaxProvider.fetchRates', () => {
  it('returns BTC_NGN pair with buy/sell swapped (Quidax buy → our sell)', async () => {
    mock_ok(MOCK_TICKER_RESPONSE);
    const provider = make_provider();
    const rates = await provider.fetchRates();

    const btc = rates.find((r) => r.pair === AssetPair.BTC_NGN)!;
    expect(btc).toBeDefined();
    // Quidax 'sell' (what they sell BTC for in NGN) = best rate customer buys at → our rate_buy
    expect(btc.rate_buy).toEqual(new Decimal('98000000.0'));
    // Quidax 'buy' (what they buy BTC for in NGN) = rate customer sells at → our rate_sell
    expect(btc.rate_sell).toEqual(new Decimal('97000000.0'));
  });

  it('derives SAT_NGN from BTC_NGN by dividing by 100_000_000', async () => {
    mock_ok(MOCK_TICKER_RESPONSE);
    const provider = make_provider();
    const rates = await provider.fetchRates();

    const sat = rates.find((r) => r.pair === AssetPair.SAT_NGN)!;
    expect(sat).toBeDefined();
    expect(sat.rate_buy).toEqual(new Decimal('98000000.0').div('100000000'));
    expect(sat.rate_sell).toEqual(new Decimal('97000000.0').div('100000000'));
  });

  it('returns USDT_NGN pair', async () => {
    mock_ok(MOCK_TICKER_RESPONSE);
    const provider = make_provider();
    const rates = await provider.fetchRates();

    const usdt = rates.find((r) => r.pair === AssetPair.USDT_NGN)!;
    expect(usdt).toBeDefined();
    expect(usdt.rate_buy).toEqual(new Decimal('1610.0'));
    expect(usdt.rate_sell).toEqual(new Decimal('1590.0'));
  });

  it('sets fetched_at to a recent timestamp', async () => {
    mock_ok(MOCK_TICKER_RESPONSE);
    const before = new Date();
    const provider = make_provider();
    const rates = await provider.fetchRates();
    const after = new Date();

    for (const r of rates) {
      expect(r.fetched_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(r.fetched_at.getTime()).toBeLessThanOrEqual(after.getTime());
    }
  });

  it('sends api-key header', async () => {
    mock_ok(MOCK_TICKER_RESPONSE);
    const provider = make_provider();
    await provider.fetchRates();

    const call = (global.fetch as jest.Mock).mock.calls[0];
    expect((call[1].headers as Record<string, string>)['api-key']).toBe('test_key');
  });

  it('throws on non-ok HTTP response', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' });
    await expect(make_provider().fetchRates()).rejects.toThrow('503');
  });

  it('throws when Zod validation fails', async () => {
    mock_ok({ status: 'success', data: { btcngn: { ticker: { buy: null, sell: null } } } });
    await expect(make_provider().fetchRates()).rejects.toThrow('validation failed');
  });

  it('throws when response contains no recognised pairs', async () => {
    mock_ok({ status: 'success', data: { unknownpair: { ticker: { buy: '1.0', sell: '1.0' } } } });
    await expect(make_provider().fetchRates()).rejects.toThrow('no usable rate pairs');
  });

  it('ignores unknown pairs without throwing', async () => {
    mock_ok({
      status: 'success',
      data: {
        btcngn: { ticker: { buy: '97000000.0', sell: '98000000.0' } },
        xrpngn: { ticker: { buy: '500.0', sell: '510.0' } }, // unknown — skipped
      },
    });
    const rates = await make_provider().fetchRates();
    expect(rates.every((r) => r.pair !== ('XRPNGN' as AssetPair))).toBe(true);
  });
});
