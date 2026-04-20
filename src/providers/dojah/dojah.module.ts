import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { ProvidersConfig } from '@/config/providers.config';
import { DojahProvider } from './dojah.provider';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: DojahProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new DojahProvider(config.get<ProvidersConfig>('providers')!.dojah),
    },
  ],
  exports: [DojahProvider],
})
export class DojahModule {}
