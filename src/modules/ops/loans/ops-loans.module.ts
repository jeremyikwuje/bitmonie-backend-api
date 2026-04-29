import { Module } from '@nestjs/common';
import { DatabaseModule } from '@/database/database.module';
import { OpsAuthModule } from '@/modules/ops/auth/ops-auth.module';
import { OpsLoansController } from './ops-loans.controller';
import { OpsLoansService } from './ops-loans.service';

// Mirrors OpsDisbursementsModule. Ops-only loan remediation actions live here.
// Currently exposes the bad-rate liquidation reversal — the only sanctioned
// LIQUIDATED → ACTIVE backward transition. Audit machinery (OpsAuditService +
// OpsGuard) comes via OpsAuthModule.
@Module({
  imports: [DatabaseModule, OpsAuthModule],
  controllers: [OpsLoansController],
  providers:   [OpsLoansService],
})
export class OpsLoansModule {}
