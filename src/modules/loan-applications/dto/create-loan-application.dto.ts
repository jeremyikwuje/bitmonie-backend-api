import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import {
  LOAN_APPLICATION_COLLATERAL_DISPLAYS,
  type LoanApplicationCollateralDisplay,
} from '../loan-applications.constants';
import { IsValidApplicationPhone } from './is-valid-application-phone.validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const lowercase_trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

// Public payload for POST /v1/loan-applications. Source of truth in
// docs/loan-applications.md §2.1 + §3.
//
// Note on bot-trap fields (`website`, `rendered_at`): they are read by
// BotTrapGuard before this DTO is validated. Declared here only so that
// ValidationPipe's `forbidNonWhitelisted` doesn't 400 them when a real client
// includes them. The guard inspects raw req.body; this DTO does not enforce
// their bot-trap semantics.
export class CreateLoanApplicationDto {
  @ApiProperty({ example: 'Ada', maxLength: 80 })
  @Transform(trim)
  @IsString({ message: 'First name is required' })
  @MinLength(1, { message: 'First name is required' })
  @MaxLength(80, { message: 'First name is too long' })
  first_name!: string;

  @ApiProperty({ example: 'Lovelace', maxLength: 80 })
  @Transform(trim)
  @IsString({ message: 'Last name is required' })
  @MinLength(1, { message: 'Last name is required' })
  @MaxLength(80, { message: 'Last name is too long' })
  last_name!: string;

  @ApiProperty({ example: 'ada@example.com', maxLength: 160 })
  @Transform(lowercase_trim)
  @IsString({ message: 'Valid email is required' })
  @MaxLength(160, { message: 'Valid email is required' })
  @IsEmail({}, { message: 'Valid email is required' })
  email!: string;

  @ApiProperty({ example: '+234 803 555 1234', maxLength: 40 })
  @IsString({ message: 'Valid phone is required' })
  @IsValidApplicationPhone({ message: 'Valid phone is required' })
  phone!: string;

  @ApiProperty({
    enum: LOAN_APPLICATION_COLLATERAL_DISPLAYS,
    example: 'Bitcoin (BTC)',
  })
  @IsIn(LOAN_APPLICATION_COLLATERAL_DISPLAYS as readonly string[], {
    message: 'Select a collateral type',
  })
  collateral_type!: LoanApplicationCollateralDisplay;

  @ApiProperty({ example: '0.05 BTC', maxLength: 1000, required: false })
  @Transform(trim)
  @IsOptional()
  @IsString({ message: 'Description must be a string' })
  @MaxLength(1000, { message: 'Description is too long' })
  collateral_description?: string;

  @ApiProperty({
    example: 5_000_000,
    minimum: 1,
    maximum: 100_000_000,
    description: 'Integer naira amount',
  })
  @IsInt({ message: 'Enter a loan amount' })
  @Min(1, { message: 'Enter a loan amount' })
  @Max(100_000_000, { message: 'Loan amount cannot exceed N100,000,000' })
  loan_amount_ngn!: number;

  // ── Bot-trap fields (see BotTrapGuard + docs/loan-applications.md §6.1–§6.2)

  @ApiProperty({ required: false, description: 'Honeypot — must be empty.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;

  @ApiProperty({
    required: false,
    description: 'Unix-ms timestamp captured when the form mounted.',
  })
  @IsOptional()
  @IsInt()
  rendered_at?: number;
}
