import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { ProvidersConfig } from '@/config/providers.config';
import { BlinkProvider } from './blink.provider';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: BlinkProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new BlinkProvider(config.get<ProvidersConfig>('providers')!.blink),
    },
  ],
  exports: [BlinkProvider],
})
export class BlinkModule {}
