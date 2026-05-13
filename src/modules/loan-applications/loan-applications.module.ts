import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoanApplicationsController } from './loan-applications.controller';
import { LoanApplicationsService } from './loan-applications.service';
import { LoanApplicationsRepository } from './loan-applications.repository';
import { BotTrapGuard } from './guards/bot-trap.guard';
import { LoanApplicationsThrottlerGuard } from './guards/loan-applications-throttler.guard';
import { DatabaseModule } from '@/database/database.module';
import { OpsAlertsModule } from '@/modules/ops-alerts/ops-alerts.module';

@Module({
  imports:     [ConfigModule, DatabaseModule, OpsAlertsModule],
  controllers: [LoanApplicationsController],
  providers:   [
    LoanApplicationsService,
    LoanApplicationsRepository,
    BotTrapGuard,
    LoanApplicationsThrottlerGuard,
  ],
})
export class LoanApplicationsModule {}
