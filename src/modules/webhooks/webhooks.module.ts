import { Module } from '@nestjs/common';
import { PrismaService } from '@/database/prisma.service';
import { InflowsModule } from '@/modules/inflows/inflows.module';
import { LoansModule } from '@/modules/loans/loans.module';
import { DisbursementsModule } from '@/modules/disbursements/disbursements.module';
import { PaymentRequestsModule } from '@/modules/payment-requests/payment-requests.module';
import { UserRepaymentAccountsModule } from '@/modules/user-repayment-accounts/user-repayment-accounts.module';
import { OpsAlertsModule } from '@/modules/ops-alerts/ops-alerts.module';
import { WebhooksLogModule } from '@/modules/webhooks-log/webhooks-log.module';
import { BlinkModule } from '@/providers/blink/blink.module';
import { PalmpayModule } from '@/providers/palmpay/palmpay.module';
import { BlinkWebhookController } from './blink.webhook.controller';
import { PalmpayPayoutWebhookController } from './palmpay-payout.webhook.controller';
import { PalmpayCollectionVaWebhookController } from './palmpay-collection-va.webhook.controller';

@Module({
  imports: [
    BlinkModule,
    PalmpayModule,
    InflowsModule,
    LoansModule,
    DisbursementsModule,
    PaymentRequestsModule,
    UserRepaymentAccountsModule,
    OpsAlertsModule,
    WebhooksLogModule,
  ],
  controllers: [
    BlinkWebhookController,
    PalmpayPayoutWebhookController,
    PalmpayCollectionVaWebhookController,
  ],
  providers: [PrismaService],
})
export class WebhooksModule {}
