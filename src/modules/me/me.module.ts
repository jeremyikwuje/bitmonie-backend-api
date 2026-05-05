import { Module } from '@nestjs/common';
import { PrismaService } from '@/database/prisma.service';
import { LoansModule } from '@/modules/loans/loans.module';
import { PriceFeedModule } from '@/modules/price-feed/price-feed.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { MeController } from './me.controller';
import { MeService } from './me.service';
import { ActivityController } from './activity.controller';
import { ActivityService } from './activity.service';

@Module({
  imports: [LoansModule, PriceFeedModule, AuthModule],
  controllers: [MeController, ActivityController],
  providers: [PrismaService, MeService, ActivityService],
})
export class MeModule {}
