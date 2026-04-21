import { Module } from '@nestjs/common';
import { PrismaService } from '@/database/prisma.service';
import { InflowsModule } from '@/modules/inflows/inflows.module';
import { LoansModule } from '@/modules/loans/loans.module';
import { DisbursementsModule } from '@/modules/disbursements/disbursements.module';
import { PaymentRequestsModule } from '@/modules/payment-requests/payment-requests.module';
import { BlinkModule } from '@/providers/blink/blink.module';
import { PalmpayModule } from '@/providers/palmpay/palmpay.module';
import { BlinkWebhookController } from './blink.webhook.controller';
import { PalmpayWebhookController } from './palmpay.webhook.controller';

@Module({
  imports: [
    BlinkModule,
    PalmpayModule,
    InflowsModule,
    LoansModule,
    DisbursementsModule,
    PaymentRequestsModule,
  ],
  controllers: [BlinkWebhookController, PalmpayWebhookController],
  providers: [PrismaService],
})
export class WebhooksModule {}
