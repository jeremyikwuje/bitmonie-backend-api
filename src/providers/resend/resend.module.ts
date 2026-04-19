import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ResendProvider } from './resend.provider';
import type { ProvidersConfig } from '@/config/providers.config';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: ResendProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ResendProvider => {
        const pc = config.get<ProvidersConfig>('providers')!;
        return new ResendProvider(pc.resend);
      },
    },
  ],
  exports: [ResendProvider],
})
export class ResendModule {}
