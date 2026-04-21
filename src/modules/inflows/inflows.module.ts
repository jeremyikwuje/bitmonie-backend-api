import { Module } from '@nestjs/common';
import { PrismaService } from '@/database/prisma.service';
import { PaymentRequestsModule } from '@/modules/payment-requests/payment-requests.module';
import { InflowsService } from './inflows.service';

@Module({
  imports: [PaymentRequestsModule],
  providers: [PrismaService, InflowsService],
  exports: [InflowsService],
})
export class InflowsModule {}
