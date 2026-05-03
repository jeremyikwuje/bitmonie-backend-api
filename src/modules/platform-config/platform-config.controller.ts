import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  COLLATERAL_INVOICE_EXPIRY_SEC,
  COLLATERAL_TOPUP_EXPIRY_SEC,
  CUSTODY_FEE_PER_100_USD_NGN,
  DAILY_INTEREST_RATE_BPS,
  LIQUIDATION_THRESHOLD,
  LOAN_GRACE_PERIOD_DAYS,
  LOAN_LTV_PERCENT,
  MAX_LOAN_DURATION_DAYS,
  MAX_SELFSERVE_LOAN_NGN,
  MIN_LOAN_DURATION_DAYS,
  MIN_LOAN_NGN,
  MIN_PARTIAL_REPAYMENT_NGN,
  ORIGINATION_FEE_PER_100K_NGN,
} from '@/common/constants';
import { displayNgn } from '@/common/formatting/ngn-display';
import { PlatformConfigResponseDto } from './dto/platform-config-response.dto';

@ApiTags('config')
@Controller('config')
export class PlatformConfigController {
  @Get()
  @ApiOperation({
    summary: 'Public platform configuration — fees, limits, durations',
    description:
      'Returns customer-facing config. Public, no auth, cacheable. ' +
      'Namespaced by product (loans now; offramp and others to follow).',
  })
  @ApiResponse({ status: 200, type: PlatformConfigResponseDto })
  getConfig(): PlatformConfigResponseDto {
    return {
      loans: {
        fees: {
          origination_fee_per_100k_ngn: displayNgn(ORIGINATION_FEE_PER_100K_NGN, 'ceil'),
          daily_interest_rate_bps:      DAILY_INTEREST_RATE_BPS,
          custody_fee_per_100_usd_ngn:  displayNgn(CUSTODY_FEE_PER_100_USD_NGN, 'ceil'),
        },
        limits: {
          min_loan_ngn:              displayNgn(MIN_LOAN_NGN, 'ceil'),
          max_selfserve_loan_ngn:    displayNgn(MAX_SELFSERVE_LOAN_NGN, 'ceil'),
          min_partial_repayment_ngn: displayNgn(MIN_PARTIAL_REPAYMENT_NGN, 'ceil'),
        },
        durations: {
          min_duration_days: MIN_LOAN_DURATION_DAYS,
          max_duration_days: MAX_LOAN_DURATION_DAYS,
          grace_period_days: LOAN_GRACE_PERIOD_DAYS,
        },
        collateral: {
          ltv_percent:           LOAN_LTV_PERCENT.toFixed(2),
          liquidation_threshold: LIQUIDATION_THRESHOLD.toFixed(2),
          invoice_expiry_sec:    COLLATERAL_INVOICE_EXPIRY_SEC,
          topup_expiry_sec:      COLLATERAL_TOPUP_EXPIRY_SEC,
        },
      },
    };
  }
}
