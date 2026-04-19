import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { ProvidersConfig } from '@/config/providers.config';
import { QuidaxProvider } from './quidax.provider';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: QuidaxProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService): QuidaxProvider => {
        const pc = config.get<ProvidersConfig>('providers')!;
        return new QuidaxProvider(pc.quidax);
      },
    },
  ],
  exports: [QuidaxProvider],
})
export class QuidaxModule {}
