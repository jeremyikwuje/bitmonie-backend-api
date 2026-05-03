import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { AssetPair } from '@prisma/client';
import Decimal from 'decimal.js';
import { SessionGuard } from '@/common/guards/session.guard';
import { KycTierGuard } from '@/common/guards/kyc-tier.guard';
import { RequiresKyc } from '@/common/decorators/requires-kyc.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { displayNgn } from '@/common/formatting/ngn-display';
import { LoansService } from './loans.service';
import { CalculatorService } from './calculator.service';
import { PriceFeedService } from '@/modules/price-feed/price-feed.service';
import { PRICE_QUOTE_PROVIDER, type PriceQuoteProvider } from './price-quote.provider.interface';
import { Inject } from '@nestjs/common';
import { CheckoutLoanDto } from './dto/checkout-loan.dto';
import { SetReleaseAddressDto } from './dto/set-release-address.dto';
import { CalculateLoanDto } from './dto/calculate-loan.dto';

@ApiTags('loans')
@Controller('loans')
export class LoansController {
  constructor(
    private readonly loans: LoansService,
    private readonly calculator: CalculatorService,
    private readonly price_feed: PriceFeedService,
    @Inject(PRICE_QUOTE_PROVIDER)
    private readonly price_quote: PriceQuoteProvider,
  ) {}

  @Post('checkout')
  @UseGuards(SessionGuard, KycTierGuard)
  @RequiresKyc(1)
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new loan and generate a collateral payment request' })
  @ApiResponse({ status: 201, description: 'Loan created — payment request returned' })
  @ApiResponse({ status: 422, description: 'Price stale / disbursement account missing' })
  async checkoutLoan(
    @CurrentUser() user: User,
    @Body() dto: CheckoutLoanDto,
  ) {
    return this.loans.checkoutLoan(user, dto);
  }

  @Get('calculate')
  @ApiOperation({ summary: 'Public loan fee quote calculator (projections; actual fees accrue daily)' })
  @ApiResponse({ status: 200, description: 'Projections + locked-at-origination fees returned' })
  async calculateLoan(@Query() dto: CalculateLoanDto) {
    const [sat_rates, btc_usd_rate] = await Promise.all([
      this.price_feed.getCurrentRate(AssetPair.SAT_NGN),
      this.price_quote.getBtcUsdRate(),
    ]);
    const principal = new Decimal(dto.principal_ngn);
    const result = this.calculator.calculate({
      principal_ngn: principal,
      duration_days: dto.duration_days,
      sat_ngn_rate:  sat_rates.rate_sell,
      btc_usd_rate,
    });
    return {
      principal_ngn:                displayNgn(principal, 'ceil'),
      duration_days:                dto.duration_days,
      ltv_percent:                  result.ltv_percent.toFixed(2),

      collateral_amount_sat:        result.collateral_amount_sat.toString(),
      initial_collateral_usd:       result.initial_collateral_usd.toFixed(2),
      sat_ngn_rate_at_creation:     result.sat_ngn_rate_at_creation.toFixed(6),

      // Locked at origination — fees customer ultimately pays us → ceil
      origination_fee_ngn:          displayNgn(result.origination_fee_ngn, 'ceil'),
      daily_custody_fee_ngn:        displayNgn(result.daily_custody_fee_ngn, 'ceil'),
      daily_interest_rate_bps:      result.daily_interest_rate_bps,

      // Estimates for the chosen duration — customer pays us → ceil
      projected_interest_ngn:       displayNgn(result.projected_interest_ngn, 'ceil'),
      projected_custody_ngn:        displayNgn(result.projected_custody_ngn, 'ceil'),
      projected_total_ngn:          displayNgn(result.projected_total_ngn, 'ceil'),

      // Disclosure — what the customer's bank receives (we pay → floor) vs.
      // what they pay back (customer pays us → ceil).
      amount_to_receive_ngn:        displayNgn(result.amount_to_receive_ngn, 'floor'),
      amount_to_repay_estimate_ngn: displayNgn(result.amount_to_repay_estimate_ngn, 'ceil'),

      // Rates — keep precision (UI displays these as price-style figures)
      initial_liquidation_rate_ngn: result.initial_liquidation_rate_ngn.toFixed(6),
      initial_alert_rate_ngn:       result.initial_alert_rate_ngn.toFixed(6),
    };
  }

  @Get()
  @UseGuards(SessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List all loans for the authenticated user' })
  @ApiResponse({ status: 200 })
  async getLoans(@CurrentUser() user: User) {
    return this.loans.getLoans(user.id);
  }

  @Get(':id')
  @UseGuards(SessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get a single loan with status timeline' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'Loan not found' })
  async getLoan(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.loans.getLoan(user.id, id);
  }

  @Post(':id/cancel')
  @UseGuards(SessionGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancel a PENDING_COLLATERAL loan' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 409, description: 'Invalid status transition' })
  async cancelLoan(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.loans.cancelLoan(user.id, id);
  }

  @Patch(':id/release-address')
  @UseGuards(SessionGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Set or change the Lightning address for collateral release after repayment',
    description:
      'First-set (NULL → value) is allowed with just an authenticated session. ' +
      'CHANGING an existing address requires step-up verification: email OTP always, ' +
      'plus TOTP if the user has 2FA enabled. Request the email OTP via ' +
      'POST /v1/loans/:id/release-address/request-change-otp before submitting. ' +
      'Refused once collateral has been released — that address is bound to the actual send.',
  })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 401, description: 'Wrong TOTP code' })
  @ApiResponse({ status: 409, description: 'Loan already released' })
  @ApiResponse({ status: 422, description: 'Email OTP missing/invalid/expired or 2FA code missing' })
  async setReleaseAddress(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetReleaseAddressDto,
  ): Promise<void> {
    await this.loans.setReleaseAddress(user.id, id, dto.collateral_release_address, {
      email_otp: dto.email_otp,
      totp_code: dto.totp_code,
    });
  }

  @Post(':id/release-address/request-change-otp')
  @UseGuards(SessionGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Email a 6-digit OTP that authorises a change to the release address on this loan',
    description:
      'Sends a confirmation code to the customer\'s verified email. The code is scoped to ' +
      '(user, loan) and expires in 15 minutes. Submit it together with the new address (and ' +
      'TOTP if 2FA is enabled) on PATCH /v1/loans/:id/release-address. Refused if the loan has ' +
      'no existing address yet (use the PATCH directly — first-set is exempt) or if collateral ' +
      'has already been released.',
  })
  @ApiResponse({ status: 204, description: 'OTP sent (or silently skipped if email send is unavailable)' })
  @ApiResponse({ status: 409, description: 'Loan already released, OR no existing address to change' })
  async requestReleaseAddressChangeOtp(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.loans.requestReleaseAddressChangeOtp(user.id, id);
  }

  @Post(':id/add-collateral')
  @UseGuards(SessionGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create a fresh Lightning invoice for adding collateral to an ACTIVE loan',
    description:
      'Variable-amount BOLT11 invoice. Customer chooses how much SAT to send. ' +
      'At most one PENDING top-up per loan at a time. Idempotency-Key header required.',
  })
  @ApiResponse({ status: 201, description: 'Top-up invoice created' })
  @ApiResponse({ status: 404, description: 'Loan not found for user' })
  @ApiResponse({ status: 409, description: 'Loan not ACTIVE, or pending top-up already exists' })
  async addCollateral(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.loans.createCollateralTopUp(user.id, id);
  }

  @Get(':id/repayment-instructions')
  @UseGuards(SessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get NGN repayment instructions for an ACTIVE loan',
    description:
      'Returns the user\'s permanent NGN virtual account (where to send a bank transfer), ' +
      'the live outstanding breakdown, and the minimum partial-repayment floor. ' +
      'Repayments apply via custody → interest → principal waterfall.',
  })
  @ApiResponse({ status: 200, description: 'Repayment account + outstanding returned' })
  @ApiResponse({ status: 404, description: 'Loan not found' })
  @ApiResponse({ status: 409, description: 'Loan not ACTIVE' })
  @ApiResponse({ status: 422, description: 'Repayment account not yet provisioned' })
  async getRepaymentInstructions(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.loans.getRepaymentInstructions(user.id, id);
  }

  @Post(':id/claim-inflow')
  @UseGuards(SessionGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: '[DEPRECATED] Credit the most recent unmatched repayment inflow to this loan',
    deprecated: true,
    description:
      'DEPRECATED — use GET /v1/inflows/unmatched + POST /v1/inflows/:inflow_id/apply ' +
      'instead, which lets the customer pick which specific inflow to apply.\n\n' +
      'This endpoint is kept for backwards compatibility. It searches the most recent unmatched ' +
      'NGN inflow for the user (≥ N10,000, within 24h) and applies it to the chosen loan via ' +
      'the standard waterfall. Idempotency-Key header required.',
  })
  @ApiResponse({ status: 200, description: 'Inflow claimed and credited' })
  @ApiResponse({ status: 404, description: 'Loan not found, or no unmatched inflow in window' })
  @ApiResponse({ status: 409, description: 'Loan not ACTIVE' })
  async claimInflow(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.loans.claimInflow(user.id, id);
  }
}
