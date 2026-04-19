import { PrismaService } from '@/database/prisma.service';
import { Injectable } from '@nestjs/common';
import { AssetPair } from '@prisma/client';
import Decimal from 'decimal.js';

@Injectable()
export class PriceFeedRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insertRate(params: {
    pair: AssetPair;
    rate_buy_origin: Decimal;
    rate_sell_origin: Decimal;
    rate_buy: Decimal;
    rate_sell: Decimal;
    markup_percent: Decimal;
    source: string;
    fetched_at: Date;
  }): Promise<void> {
    await this.prisma.priceFeed.create({ data: params });
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
