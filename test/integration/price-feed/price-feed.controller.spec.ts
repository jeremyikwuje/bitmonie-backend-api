import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { PriceFeedController } from '@/modules/price-feed/price-feed.controller';
import { PriceFeedService } from '@/modules/price-feed/price-feed.service';
import { GlobalExceptionFilter } from '@/common/filters/global-exception.filter';
import { LoanPriceStaleException } from '@/common/errors/bitmonie.errors';
import { RatesResponseDto } from '@/modules/price-feed/dto/rates-response.dto';
import { RateItemDto } from '@/modules/price-feed/dto/rate-item.dto';
import { AssetPair } from '@prisma/client';

function make_rate_item(pair: AssetPair): RateItemDto {
  const item = new RateItemDto();
  item.pair = pair;
  item.rate_buy = '1600.000000';
  item.rate_sell = '1580.000000';
  item.fetched_at = new Date().toISOString();
  return item;
}

const mock_rates: RatesResponseDto = {
  rates: [
    make_rate_item(AssetPair.SAT_NGN),
    make_rate_item(AssetPair.BTC_NGN),
    make_rate_item(AssetPair.USDT_NGN),
  ],
};

describe('PriceFeedController (integration)', () => {
  let app: INestApplication;
  let price_feed_service: { getRates: jest.Mock; getCurrentRate: jest.Mock; isStale: jest.Mock };

  beforeEach(async () => {
    price_feed_service = {
      getRates: jest.fn(),
      getCurrentRate: jest.fn(),
      isStale: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PriceFeedController],
      providers: [{ provide: PriceFeedService, useValue: price_feed_service }],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /rates', () => {
    it('returns 200 with all rate pairs when feed is fresh', async () => {
      price_feed_service.getRates.mockResolvedValue(mock_rates);

      const response = await request(app.getHttpServer()).get('/rates').expect(200);

      expect(response.body.rates).toHaveLength(3);
      expect(response.body.rates[0]).toMatchObject({
        pair: 'SAT_NGN',
        rate_buy: '1600.000000',
        rate_sell: '1580.000000',
      });
      expect(response.body.rates[0]).toHaveProperty('fetched_at');
    });

    it('returns 422 with LOAN_PRICE_STALE code when feed is stale', async () => {
      price_feed_service.getRates.mockRejectedValue(
        new LoanPriceStaleException({ last_updated_ms: 180_000 }),
      );

      const response = await request(app.getHttpServer()).get('/rates').expect(422);

      expect(response.body.error.code).toBe('LOAN_PRICE_STALE');
      expect(response.body.error).toHaveProperty('message');
      expect(response.body.error).toHaveProperty('details');
    });

    it('returns 200 with sat_ngn, btc_ngn and usdt_ngn pairs', async () => {
      price_feed_service.getRates.mockResolvedValue(mock_rates);

      const response = await request(app.getHttpServer()).get('/rates').expect(200);

      const pairs = response.body.rates.map((r: RateItemDto) => r.pair);
      expect(pairs).toContain('SAT_NGN');
      expect(pairs).toContain('BTC_NGN');
      expect(pairs).toContain('USDT_NGN');
    });

    it('is accessible without auth (public endpoint)', async () => {
      price_feed_service.getRates.mockResolvedValue(mock_rates);
      // No session cookie — should still succeed
      await request(app.getHttpServer()).get('/rates').expect(200);
    });
  });
});
