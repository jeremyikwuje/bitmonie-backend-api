import { Module } from '@nestjs/common';
import { DatabaseModule } from '@/database/database.module';
import { OpsAuthModule } from '@/modules/ops/auth/ops-auth.module';
import { DisbursementsModule } from '@/modules/disbursements/disbursements.module';
import { OpsDisbursementsController } from './ops-disbursements.controller';
import { OpsDisbursementsService } from './ops-disbursements.service';

// Mirrors OpsKycModule: thin wrapper around DisbursementsService +
// OutflowsService, namespaced under /v1/ops/disbursements and behind
// OpsGuard. Audit machinery (OpsAuditService + OpsGuard) comes via
// OpsAuthModule. DisbursementsModule exports both DisbursementsService and
// OutflowsService — we re-use them rather than reimplementing state changes.
@Module({
  imports: [DatabaseModule, OpsAuthModule, DisbursementsModule],
  controllers: [OpsDisbursementsController],
  providers: [OpsDisbursementsService],
})
export class OpsDisbursementsModule {}
