import { Test, TestingModule } from '@nestjs/testing';
import { PriceFeedService } from '@/modules/price-feed/price-feed.service';
import { PriceFeedRepository } from '@/modules/price-feed/price-feed-repository';
import { REDIS_CLIENT } from '@/database/redis.module';
import { LoanPriceStaleException } from '@/common/errors/bitmonie.errors';
import { PRICE_FEED_STALE_MS } from '@/common/constants';
import { AssetPair } from '@prisma/client';
import Decimal from 'decimal.js';
import { mock, MockProxy } from 'jest-mock-extended';

describe('PriceFeedService', () => {
  let service: PriceFeedService;
  let repository: MockProxy<PriceFeedRepository>;
  let redis: { get: jest.Mock };

  const fresh_rate = {
    rate_buy: new Decimal('1600'),
    rate_sell: new Decimal('1580'),
    fetched_at: new Date(),
  };

  const stale_rate = {
    rate_buy: new Decimal('1600'),
    rate_sell: new Decimal('1580'),
    fetched_at: new Date(Date.now() - PRICE_FEED_STALE_MS - 5_000),
  };

  const cached_rate_json = JSON.stringify({ buy: '1600.000000', sell: '1580.000000' });

  beforeEach(async () => {
    repository = mock<PriceFeedRepository>();
    redis = { get: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PriceFeedService,
        { provide: PriceFeedRepository, useValue: repository },
        { provide: REDIS_CLIENT, useValue: redis },
      ],
    }).compile();

    service = module.get<PriceFeedService>(PriceFeedService);
  });

  describe('getCurrentRate', () => {
    it('returns rate from Redis cache when available', async () => {
      redis.get.mockImplementation((key: string) => {
        if (key === 'price:stale') return Promise.resolve(null);
        if (key === 'price:SAT_NGN') return Promise.resolve(cached_rate_json);
        return Promise.resolve(null);
      });

      const result = await service.getCurrentRate(AssetPair.SAT_NGN);

      expect(result.rate_buy).toEqual(new Decimal('1600.000000'));
      expect(result.rate_sell).toEqual(new Decimal('1580.000000'));
      expect(repository.getLatestRate).not.toHaveBeenCalled();
    });

    it('falls back to DB when Redis cache is empty and feed is fresh', async () => {
      redis.get.mockResolvedValue(null);
      repository.getLatestRate.mockResolvedValue(fresh_rate);

      const result = await service.getCurrentRate(AssetPair.SAT_NGN);

      expect(result.rate_buy).toEqual(fresh_rate.rate_buy);
      expect(result.rate_sell).toEqual(fresh_rate.rate_sell);
      expect(repository.getLatestRate).toHaveBeenCalledWith(AssetPair.SAT_NGN);
    });

    it('throws LoanPriceStaleException when price:stale flag is set in Redis', async () => {
      redis.get.mockImplementation((key: string) => {
        if (key === 'price:stale') return Promise.resolve(String(Date.now() - 60_000));
        return Promise.resolve(null);
      });

      await expect(service.getCurrentRate(AssetPair.SAT_NGN)).rejects.toThrow(LoanPriceStaleException);
    });

    it('skips DB lookup entirely when price:stale flag is set (fast-path)', async () => {
      redis.get.mockImplementation((key: string) => {
        if (key === 'price:stale') return Promise.resolve(String(Date.now() - 60_000));
        return Promise.resolve(null);
      });

      await expect(service.getCurrentRate(AssetPair.SAT_NGN)).rejects.toThrow(LoanPriceStaleException);
      expect(repository.getLatestRate).not.toHaveBeenCalled();
    });

    it('throws LoanPriceStaleException when DB rate is beyond PRICE_FEED_STALE_MS', async () => {
      redis.get.mockResolvedValue(null);
      repository.getLatestRate.mockResolvedValue(stale_rate);

      await expect(service.getCurrentRate(AssetPair.SAT_NGN)).rejects.toThrow(LoanPriceStaleException);
    });

    it('throws LoanPriceStaleException when no rate exists in DB at all', async () => {
      redis.get.mockResolvedValue(null);
      repository.getLatestRate.mockResolvedValue(null);

      await expect(service.getCurrentRate(AssetPair.SAT_NGN)).rejects.toThrow(LoanPriceStaleException);
    });

    it('returns Decimal values (not JS numbers) from cache', async () => {
      redis.get.mockImplementation((key: string) => {
        if (key === 'price:stale') return Promise.resolve(null);
        return Promise.resolve(cached_rate_json);
      });

      const result = await service.getCurrentRate(AssetPair.SAT_NGN);

      expect(result.rate_buy).toBeInstanceOf(Decimal);
      expect(result.rate_sell).toBeInstanceOf(Decimal);
    });
  });

  describe('getRates', () => {
    it('returns rates for all standard pairs', async () => {
      redis.get.mockImplementation((key: string) => {
        if (key === 'price:stale') return Promise.resolve(null);
        return Promise.resolve(cached_rate_json);
      });

      const result = await service.getRates();

      expect(result.rates).toHaveLength(3);
      expect(result.rates.map((r) => r.pair)).toEqual(
        expect.arrayContaining([AssetPair.SAT_NGN, AssetPair.BTC_NGN, AssetPair.USDT_NGN]),
      );
    });

    it('serialises rates as strings with 6 decimal places', async () => {
      redis.get.mockImplementation((key: string) => {
        if (key === 'price:stale') return Promise.resolve(null);
        return Promise.resolve(cached_rate_json);
      });

      const result = await service.getRates();
      const sat_item = result.rates.find((r) => r.pair === AssetPair.SAT_NGN);

      expect(sat_item?.rate_buy).toMatch(/^\d+\.\d{6}$/);
      expect(sat_item?.rate_sell).toMatch(/^\d+\.\d{6}$/);
    });

    it('propagates LoanPriceStaleException from getCurrentRate', async () => {
      redis.get.mockImplementation((key: string) => {
        if (key === 'price:stale') return Promise.resolve(String(Date.now() - 60_000));
        return Promise.resolve(null);
      });

      await expect(service.getRates()).rejects.toThrow(LoanPriceStaleException);
    });
  });

  describe('isStale', () => {
    it('returns true when price:stale flag is present in Redis', async () => {
      redis.get.mockImplementation((key: string) => {
        if (key === 'price:stale') return Promise.resolve(String(Date.now() - 90_000));
        return Promise.resolve(null);
      });

      expect(await service.isStale()).toBe(true);
    });

    it('returns false when stale flag absent and DB rate is fresh', async () => {
      redis.get.mockResolvedValue(null);
      repository.getLatestRate.mockResolvedValue(fresh_rate);

      expect(await service.isStale()).toBe(false);
    });

    it('returns true when DB rate is beyond PRICE_FEED_STALE_MS', async () => {
      redis.get.mockResolvedValue(null);
      repository.getLatestRate.mockResolvedValue(stale_rate);

      expect(await service.isStale()).toBe(true);
    });

    it('returns true when no rate exists in DB', async () => {
      redis.get.mockResolvedValue(null);
      repository.getLatestRate.mockResolvedValue(null);

      expect(await service.isStale()).toBe(true);
    });
  });
});
