import { forwardRef, Module } from '@nestjs/common';
import { PrismaService } from '@/database/prisma.service';
import { PaymentRequestsModule } from '@/modules/payment-requests/payment-requests.module';
import { LoansModule } from '@/modules/loans/loans.module';
import { InflowsService } from './inflows.service';
import { InflowsController } from './inflows.controller';

@Module({
  // forwardRef on LoansModule because LoansModule already imports
  // InflowsModule (via the webhook chain). The controller depends on
  // LoansService so the apply logic stays co-located with creditInflow.
  imports:     [PaymentRequestsModule, forwardRef(() => LoansModule)],
  controllers: [InflowsController],
  providers:   [PrismaService, InflowsService],
  exports:     [InflowsService],
})
export class InflowsModule {}
