import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { DatabaseModule } from '@/database/database.module';
import { CryptoModule } from '@/common/crypto/crypto.module';
import { MailgunModule } from '@/providers/mailgun/mailgun.module';
import { ResendModule } from '@/providers/resend/resend.module';
import { PostmarkModule } from '@/providers/postmark/postmark.module';
import { MailgunProvider } from '@/providers/mailgun/mailgun.provider';
import { ResendProvider } from '@/providers/resend/resend.provider';
import { PostmarkProvider } from '@/providers/postmark/postmark.provider';
import type { ProvidersConfig } from '@/config/providers.config';
import { EMAIL_PROVIDER, type EmailProvider } from './email.provider.interface';
import { RedisModule } from '@/database/redis.module';

@Module({
  imports: [DatabaseModule, CryptoModule, ConfigModule, MailgunModule, ResendModule, PostmarkModule, RedisModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionService,
    {
      provide: EMAIL_PROVIDER,
      inject: [ConfigService, MailgunProvider, ResendProvider, PostmarkProvider],
      useFactory: (
        config: ConfigService,
        mailgun: MailgunProvider,
        resend: ResendProvider,
        postmark: PostmarkProvider,
      ): EmailProvider => {
        const { active } = config.get<ProvidersConfig>('providers')!;
        switch (active.email) {
          case 'mailgun':  return mailgun;
          case 'resend':   return resend;
          case 'postmark': return postmark;
          default: throw new Error(`Unknown email provider: "${active.email}"`);
        }
      },
    },
  ],
  exports: [SessionService],
})
export class AuthModule {}
