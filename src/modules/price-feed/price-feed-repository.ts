import { PrismaService } from '@/database/prisma.service';
import { Injectable } from '@nestjs/common';
import { AssetPair } from '@prisma/client';
import Decimal from 'decimal.js';

@Injectable()
export class PriceFeedRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insertRate(
    pair: AssetPair,
    rate_buy: Decimal,
    rate_sell: Decimal,
    fetched_at: Date,
    source: string,
  ): Promise<void> {
    await this.prisma.priceFeed.create({
      data: { pair, rate_buy, rate_sell, fetched_at, source },
    });
  }

  async getLatestRate(pair: AssetPair): Promise<{
    rate_buy: Decimal;
    rate_sell: Decimal;
    fetched_at: Date;
  } | null> {
    const record = await this.prisma.priceFeed.findFirst({
      where: { pair },
      orderBy: { fetched_at: 'desc' },
    });

    if (!record) return null;

    return {
      rate_buy: new Decimal(record.rate_buy.toString()),
      rate_sell: new Decimal(record.rate_sell.toString()),
      fetched_at: record.fetched_at,
    };
  }
}
