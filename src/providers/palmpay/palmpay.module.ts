import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { ProvidersConfig } from '@/config/providers.config';
import { PalmpayProvider } from './palmpay.provider';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: PalmpayProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new PalmpayProvider(config.get<ProvidersConfig>('providers')!.palmpay),
    },
  ],
  exports: [PalmpayProvider],
})
export class PalmpayModule {}
