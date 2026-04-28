import { Module } from '@nestjs/common';
import { DatabaseModule } from '@/database/database.module';
import { KycModule } from '@/modules/kyc/kyc.module';
import { UserRepaymentAccountsModule } from '@/modules/user-repayment-accounts/user-repayment-accounts.module';
import { OpsAuthModule } from '@/modules/ops/auth/ops-auth.module';
import { OpsKycController } from './ops-kyc.controller';

// Thin wrapper around KycService + UserRepaymentAccountsService. Keeps the
// ops-only routes namespaced under /v1/ops/kyc and behind OpsGuard. The audit
// machinery (OpsAuditService + OpsGuard) comes via OpsAuthModule.
@Module({
  imports: [DatabaseModule, KycModule, UserRepaymentAccountsModule, OpsAuthModule],
  controllers: [OpsKycController],
})
export class OpsKycModule {}
