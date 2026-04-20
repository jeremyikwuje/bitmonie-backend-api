import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { ProvidersConfig } from '@/config/providers.config';
import { QoreidProvider } from './qoreid.provider';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: QoreidProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new QoreidProvider(config.get<ProvidersConfig>('providers')!.qoreid),
    },
  ],
  exports: [QoreidProvider],
})
export class QoreidModule {}
