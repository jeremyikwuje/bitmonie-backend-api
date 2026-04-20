import { Module } from '@nestjs/common';
import { DisbursementsModule } from '@/modules/disbursements/disbursements.module';
import { NameMatchService } from '@/common/name-match/name-match.service';
import { DisbursementAccountsService } from './disbursement-accounts.service';
import { DisbursementAccountsController } from './disbursement-accounts.controller';

@Module({
  imports: [DisbursementsModule],
  providers: [DisbursementAccountsService, NameMatchService],
  controllers: [DisbursementAccountsController],
  exports: [DisbursementAccountsService],
})
export class DisbursementAccountsModule {}
