import { LoanPriceStaleException } from '@/common/errors/bitmonie.errors';
import { PRICE_FEED_STALE_MS, REDIS_KEYS } from '@/common/constants';
import { REDIS_CLIENT } from '@/database/redis.module';
import { Inject, Injectable } from '@nestjs/common';
import { AssetPair } from '@prisma/client';
import Decimal from 'decimal.js';
import Redis from 'ioredis';
import { PriceFeedRepository } from './price-feed-repository';
import { RatesResponseDto } from './dto/rates-response.dto';
import { RateItemDto } from './dto/rate-item.dto';

const RATE_PAIRS: AssetPair[] = [AssetPair.SAT_NGN, AssetPair.BTC_NGN, AssetPair.USDT_NGN];

// Cached value shape stored as JSON at price:<PAIR>
interface CachedRate {
  buy: string;
  sell: string;
}

@Injectable()
export class PriceFeedService {
  constructor(
    private readonly price_feed_repository: PriceFeedRepository,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async getCurrentRate(pair: AssetPair): Promise<{ rate_buy: Decimal; rate_sell: Decimal }> {
    const stale_flag = await this.redis.get(REDIS_KEYS.PRICE_STALE);
    if (stale_flag) {
      throw new LoanPriceStaleException({
        last_updated_ms: Date.now() - parseInt(stale_flag, 10),
      });
    }

    const cached = await this.redis.get(REDIS_KEYS.PRICE(pair));
    if (cached) {
      const { buy, sell } = JSON.parse(cached) as CachedRate;
      return { rate_buy: new Decimal(buy), rate_sell: new Decimal(sell) };
    }

    const db_rate = await this.price_feed_repository.getLatestRate(pair);
    if (!db_rate) {
      throw new LoanPriceStaleException({ last_updated_ms: PRICE_FEED_STALE_MS });
    }

    if (this.isPastStaleness(db_rate.fetched_at)) {
      throw new LoanPriceStaleException({
        last_updated_ms: Date.now() - db_rate.fetched_at.getTime(),
      });
    }

    return { rate_buy: db_rate.rate_buy, rate_sell: db_rate.rate_sell };
  }

  async getRates(): Promise<RatesResponseDto> {
    const rate_items: RateItemDto[] = await Promise.all(
      RATE_PAIRS.map(async (pair): Promise<RateItemDto> => {
        const rate = await this.getCurrentRate(pair);
        const item = new RateItemDto();
        item.pair = pair;
        item.rate_buy = rate.rate_buy.toFixed(6);
        item.rate_sell = rate.rate_sell.toFixed(6);
        item.fetched_at = new Date().toISOString();
        return item;
      }),
    );

    const response = new RatesResponseDto();
    response.rates = rate_items;
    return response;
  }

  async isStale(): Promise<boolean> {
    const stale_flag = await this.redis.get(REDIS_KEYS.PRICE_STALE);
    if (stale_flag) return true;

    const latest = await this.price_feed_repository.getLatestRate(AssetPair.SAT_NGN);
    if (!latest) return true;
    return this.isPastStaleness(latest.fetched_at);
  }

  private isPastStaleness(fetched_at: Date): boolean {
    return Date.now() - fetched_at.getTime() > PRICE_FEED_STALE_MS;
  }
}
