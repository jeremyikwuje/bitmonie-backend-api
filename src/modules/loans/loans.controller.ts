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
  @ApiOperation({ summary: 'Public loan fee quote calculator' })
  @ApiResponse({ status: 200, description: 'Fee breakdown returned' })
  async calculateLoan(@Query() dto: CalculateLoanDto) {
    const [sat_rates, usdt_rates] = await Promise.all([
      this.price_feed.getCurrentRate(AssetPair.SAT_NGN),
      this.price_feed.getCurrentRate(AssetPair.USDT_NGN),
    ]);
    const principal = new Decimal(dto.principal_ngn);
    const result = this.calculator.calculate({
      principal_ngn:  principal,
      duration_days:  dto.duration_days,
      sat_ngn_rate:   sat_rates.rate_sell,
      usdt_ngn_rate:  usdt_rates.rate_sell,
    });
    return {
      collateral_amount_sat:   result.collateral_amount_sat.toString(),
      sat_ngn_rate_at_creation: result.sat_ngn_rate_at_creation.toFixed(6),
      ltv_percent:             result.ltv_percent.toFixed(2),
      origination_fee_ngn:     result.origination_fee_ngn.toFixed(2),
      daily_fee_ngn:           result.daily_fee_ngn.toFixed(2),
      total_fees_ngn:          result.total_fees_ngn.toFixed(2),
      total_amount_ngn:        result.total_amount_ngn.toFixed(2),
      liquidation_rate_ngn:    result.liquidation_rate_ngn.toFixed(6),
      alert_rate_ngn:          result.alert_rate_ngn.toFixed(6),
      duration_days:           dto.duration_days,
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
}
