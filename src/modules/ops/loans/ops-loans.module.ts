import { Module } from '@nestjs/common';
import { DatabaseModule } from '@/database/database.module';
import { OpsAuthModule } from '@/modules/ops/auth/ops-auth.module';
import { LoansModule } from '@/modules/loans/loans.module';
import { OpsLoansController } from './ops-loans.controller';
import { OpsLoansService } from './ops-loans.service';

// Mirrors OpsDisbursementsModule. Ops-only loan remediation actions live here.
// Exposes:
//   - bad-rate liquidation reversal (the only sanctioned LIQUIDATED → ACTIVE
//     backward transition; rare)
//   - manual collateral release (drives CollateralReleaseService when the
//     auto path is wedged)
// Audit machinery (OpsAuditService + OpsGuard) comes via OpsAuthModule.
// LoansModule exports CollateralReleaseService for the manual-release path.
@Module({
  imports: [DatabaseModule, OpsAuthModule, LoansModule],
  controllers: [OpsLoansController],
  providers:   [OpsLoansService],
})
export class OpsLoansModule {}
