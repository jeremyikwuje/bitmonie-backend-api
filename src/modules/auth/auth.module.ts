import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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
import { EMAIL_PROVIDER, type EmailProvider } from './email.provider.interface';
import { EMAIL_PROVIDER_CONFIG, EmailProviderName } from '@/config/email.config';
import { RedisModule } from '@/database/redis.module';

@Module({
  imports: [DatabaseModule, CryptoModule, ConfigModule, MailgunModule, ResendModule, PostmarkModule, RedisModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionService,
    {
      provide: EMAIL_PROVIDER,
      inject: [MailgunProvider, ResendProvider, PostmarkProvider],
      useFactory: (
        mailgun: MailgunProvider,
        resend: ResendProvider,
        postmark: PostmarkProvider,
      ): EmailProvider => {
        switch (EMAIL_PROVIDER_CONFIG) {
          case EmailProviderName.Mailgun:  return mailgun;
          case EmailProviderName.Resend:   return resend;
          case EmailProviderName.Postmark: return postmark;
        }
      },
    },
  ],
  exports: [SessionService, AuthService, EMAIL_PROVIDER],
})
export class AuthModule {}
