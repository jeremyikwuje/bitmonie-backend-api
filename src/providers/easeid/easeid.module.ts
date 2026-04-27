import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { ProvidersConfig } from '@/config/providers.config';
import { EaseidProvider } from './easeid.provider';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: EaseidProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new EaseidProvider(config.get<ProvidersConfig>('providers')!.easeid),
    },
  ],
  exports: [EaseidProvider],
})
export class EaseidModule {}
