import { ApiProperty } from '@nestjs/swagger';

export class LoansFeesDto {
  @ApiProperty({ example: '500.00', description: 'Origination fee per N100,000 of principal — one-time, upfront' })
  origination_fee_per_100k_ngn!: string;

  @ApiProperty({ example: 30, description: 'Daily interest on outstanding principal in basis points (30 bps = 0.3%)' })
  daily_interest_rate_bps!: number;

  @ApiProperty({ example: '100.00', description: 'Custody fee per $100 of initial collateral per day — fixed at origination' })
  custody_fee_per_100_usd_ngn!: string;
}

export class LoansLimitsDto {
  @ApiProperty({ example: '50000.00' })
  min_loan_ngn!: string;

  @ApiProperty({ example: '10000000.00', description: 'Max self-serve principal — above this, customer is routed to /get-quote' })
  max_selfserve_loan_ngn!: string;

  @ApiProperty({ example: '10000.00', description: 'Floor for partial repayments — below this, the inflow is unmatched and ops-paged' })
  min_partial_repayment_ngn!: string;
}

export class LoansDurationsDto {
  @ApiProperty({ example: 1 })
  min_duration_days!: number;

  @ApiProperty({ example: 90 })
  max_duration_days!: number;

  @ApiProperty({ example: 7, description: 'Grace window after due_at before maturity-driven liquidation' })
  grace_period_days!: number;
}

export class LoansCollateralDto {
  @ApiProperty({ example: '0.60', description: 'Initial loan-to-value — principal_ngn / collateral_ngn at origination' })
  ltv_percent!: string;

  @ApiProperty({ example: '1.10', description: 'Liquidation triggers when collateral_ngn < threshold × total outstanding' })
  liquidation_threshold!: string;

  @ApiProperty({ example: 1800, description: 'Initial collateral invoice expiry (seconds)' })
  invoice_expiry_sec!: number;

  @ApiProperty({ example: 1800, description: 'Add-collateral top-up invoice expiry (seconds)' })
  topup_expiry_sec!: number;
}

export class LoansConfigDto {
  @ApiProperty({ type: LoansFeesDto })
  fees!: LoansFeesDto;

  @ApiProperty({ type: LoansLimitsDto })
  limits!: LoansLimitsDto;

  @ApiProperty({ type: LoansDurationsDto })
  durations!: LoansDurationsDto;

  @ApiProperty({ type: LoansCollateralDto })
  collateral!: LoansCollateralDto;
}
