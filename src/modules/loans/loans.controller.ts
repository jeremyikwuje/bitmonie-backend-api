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
      principal_ngn:                principal.toFixed(2),
      duration_days:                dto.duration_days,
      ltv_percent:                  result.ltv_percent.toFixed(2),

      collateral_amount_sat:        result.collateral_amount_sat.toString(),
      initial_collateral_usd:       result.initial_collateral_usd.toFixed(2),
      sat_ngn_rate_at_creation:     result.sat_ngn_rate_at_creation.toFixed(6),

      // Locked at origination
      origination_fee_ngn:          result.origination_fee_ngn.toFixed(2),
      daily_custody_fee_ngn:        result.daily_custody_fee_ngn.toFixed(2),
      daily_interest_rate_bps:      result.daily_interest_rate_bps,

      // Estimates for the chosen duration
      projected_interest_ngn:       result.projected_interest_ngn.toFixed(2),
      projected_custody_ngn:        result.projected_custody_ngn.toFixed(2),
      projected_total_ngn:          result.projected_total_ngn.toFixed(2),

      // UI display (these move daily once accrual starts)
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
  @ApiOperation({ summary: 'Set the Lightning address for collateral release after repayment' })
  @ApiResponse({ status: 204 })
  async setReleaseAddress(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetReleaseAddressDto,
  ): Promise<void> {
    await this.loans.setReleaseAddress(user.id, id, dto.collateral_release_address);
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

  @Post(':id/claim-inflow')
  @UseGuards(SessionGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Credit a recent unmatched repayment inflow to this loan',
    description:
      'For when the customer has multiple ACTIVE loans and the webhook could not auto-match. ' +
      'Searches the most recent unmatched NGN inflow for this user (≥ N10,000, within 24h) ' +
      'and credits it via the waterfall. Idempotency-Key header required.',
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
