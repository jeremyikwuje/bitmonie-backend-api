import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PriceFeedController } from './price-feed.controller';
import { PriceFeedService } from './price-feed.service';
import { PriceFeedRepository } from './price-feed-repository';
import { MonierateProvider } from './providers/monierate.provider';
import type { ProvidersConfig } from '@/config/providers.config';

@Module({
  imports: [ConfigModule],
  controllers: [PriceFeedController],
  providers: [
    PriceFeedService,
    PriceFeedRepository,
    {
      provide: 'PRICE_FEED_PROVIDER',
      inject: [ConfigService],
      useFactory: (config: ConfigService): MonierateProvider => {
        const pc = config.get<ProvidersConfig>('providers')!;
        return new MonierateProvider(pc.price_feed.api_key, pc.price_feed.base_url);
      },
    },
  ],
  exports: [PriceFeedService],
})
export class PriceFeedModule {}
