import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DisbursementRail } from '@prisma/client';
import { DisbursementRouter } from '@/modules/disbursements/disbursement-router.service';
import type { Bank } from '@/modules/disbursements/disbursement.provider.interface';

// Public — no SessionGuard. The bank catalogue is non-sensitive public
// information and the frontend hydrates the bank-select dropdown on the
// "add disbursement account" screen, which the user reaches before any
// per-loan privileged action. The global Throttler (60/min/IP) keeps it
// from being abused.
@ApiTags('Banks')
@Controller('banks')
export class BanksController {
  constructor(private readonly disbursement_router: DisbursementRouter) {}

  // Currently fixed to NGN bank-transfer banks because that is the only
  // self-serve add-disbursement-account flow (BANK kind → BANK_TRANSFER
  // rail → PalmPay, per disbursement.config.ts). Mobile-money rails route
  // to the stub today and aren't surfaced to customers. Add `currency` /
  // `rail` query params here when that changes.
  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List banks supported by the disbursement provider',
    description:
      'Returns the catalogue of NGN bank-transfer destinations (commercial banks, MFBs, mobile-money wallets) the active disbursement provider can route to. Use the returned `code` as `provider_code` when adding a BANK disbursement account.',
  })
  @ApiResponse({ status: 200, description: 'Bank list' })
  async listBanks(): Promise<Bank[]> {
    const provider = this.disbursement_router.forRoute('NGN', DisbursementRail.BANK_TRANSFER);
    return provider.listBanks();
  }
}
