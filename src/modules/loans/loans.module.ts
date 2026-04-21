import { Module } from '@nestjs/common';
import { PrismaService } from '@/database/prisma.service';
import { PriceFeedModule } from '@/modules/price-feed/price-feed.module';
import { PaymentRequestsModule } from '@/modules/payment-requests/payment-requests.module';
import { LoansController } from './loans.controller';
import { LoansService } from './loans.service';
import { CalculatorService } from './calculator.service';
import { LoanStatusService } from './loan-status.service';

@Module({
  imports: [PriceFeedModule, PaymentRequestsModule],
  controllers: [LoansController],
  providers: [PrismaService, LoansService, CalculatorService, LoanStatusService],
  exports: [LoansService, LoanStatusService],
})
export class LoansModule {}
