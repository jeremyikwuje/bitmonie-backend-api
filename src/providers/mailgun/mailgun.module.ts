import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MailgunProvider } from './mailgun.provider';
import type { ProvidersConfig } from '@/config/providers.config';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: MailgunProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService): MailgunProvider => {
        const pc = config.get<ProvidersConfig>('providers')!;
        return new MailgunProvider(pc.mailgun);
      },
    },
  ],
  exports: [MailgunProvider],
})
export class MailgunModule {}
