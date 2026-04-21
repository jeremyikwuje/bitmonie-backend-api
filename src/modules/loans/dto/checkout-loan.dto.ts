import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import Decimal from 'decimal.js';
import { MAX_LOAN_DURATION_DAYS, MIN_LOAN_DURATION_DAYS } from '@/common/constants';

export class CheckoutLoanDto {
  @ApiProperty({ example: 300000, description: 'Loan principal in NGN' })
  @IsNumber()
  @IsPositive()
  principal_ngn!: number;

  @ApiProperty({ example: 7, description: 'Loan duration in days' })
  @IsInt()
  @Min(MIN_LOAN_DURATION_DAYS)
  @Max(MAX_LOAN_DURATION_DAYS)
  duration_days!: number;

  @ApiPropertyOptional({ description: 'Specific disbursement account ID (uses default if omitted)' })
  @IsOptional()
  @IsUUID()
  disbursement_account_id?: string;

  @ApiPropertyOptional({ description: 'Lightning address to receive collateral back after repayment' })
  @IsOptional()
  @IsString()
  collateral_release_address?: string;

  get principal_decimal(): Decimal {
    return new Decimal(this.principal_ngn);
  }
}
