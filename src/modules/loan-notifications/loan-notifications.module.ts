import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '@/database/prisma.service';
import { MailgunModule } from '@/providers/mailgun/mailgun.module';
import { ResendModule } from '@/providers/resend/resend.module';
import { PostmarkModule } from '@/providers/postmark/postmark.module';
import { MailgunProvider } from '@/providers/mailgun/mailgun.provider';
import { ResendProvider } from '@/providers/resend/resend.provider';
import { PostmarkProvider } from '@/providers/postmark/postmark.provider';
import { EMAIL_PROVIDER, type EmailProvider } from '@/modules/auth/email.provider.interface';
import { EMAIL_PROVIDER_CONFIG, EmailProviderName } from '@/config/email.config';
import { LoanNotificationsService } from './loan-notifications.service';

// Mirrors OpsAlertsModule's EMAIL_PROVIDER factory. NestJS resolves both bindings
// to the same upstream provider singletons, so duplication is wiring only —
// no extra HTTP clients or API-key copies. Standalone module so both LoansModule
// and DisbursementsModule can import it without circular-dependency risk.
@Module({
  imports: [ConfigModule, MailgunModule, ResendModule, PostmarkModule],
  providers: [
    PrismaService,
    LoanNotificationsService,
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
  exports: [LoanNotificationsService],
})
export class LoanNotificationsModule {}
