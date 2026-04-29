import { Module } from '@nestjs/common';
import { DisbursementsModule } from '@/modules/disbursements/disbursements.module';
import { BanksController } from './banks.controller';

// Public bank catalogue — used by the frontend bank-select dropdown when a
// customer is adding a BANK disbursement account. Sits beside the rest of
// the disbursement-adjacent modules and inherits the active provider
// resolution from DisbursementsModule (no separate provider wiring).
@Module({
  imports: [DisbursementsModule],
  controllers: [BanksController],
})
export class BanksModule {}
