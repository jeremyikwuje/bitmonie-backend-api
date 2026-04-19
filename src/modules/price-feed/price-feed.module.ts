import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { QuidaxModule } from '@/providers/quidax/quidax.module';
import { QuidaxProvider } from '@/providers/quidax/quidax.provider';
import type { ProvidersConfig } from '@/config/providers.config';
import type { PriceFeedProvider } from './price-feed.provider.interface';
import { PriceFeedController } from './price-feed.controller';
import { PriceFeedService } from './price-feed.service';
import { PriceFeedRepository } from './price-feed-repository';

@Module({
  imports: [ConfigModule, QuidaxModule],
  controllers: [PriceFeedController],
  providers: [
    PriceFeedService,
    PriceFeedRepository,
    {
      provide: 'PRICE_FEED_PROVIDER',
      inject: [ConfigService, QuidaxProvider],
      useFactory: (config: ConfigService, quidax: QuidaxProvider): PriceFeedProvider => {
        const { active } = config.get<ProvidersConfig>('providers')!;
        switch (active.price_feed) {
          case 'quidax': return quidax;
          default: throw new Error(`Unknown price_feed provider: "${active.price_feed}"`);
        }
      },
    },
  ],
  exports: [PriceFeedService],
})
export class PriceFeedModule {}
