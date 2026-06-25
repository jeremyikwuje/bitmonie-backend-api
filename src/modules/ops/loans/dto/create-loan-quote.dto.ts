import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';
import Decimal from 'decimal.js';

// Ops-initiated loan quote for an off-app / white-glove customer. No registered
// account is involved — the customer identity is captured for the ops audit
// trail only. Nothing is persisted as a Loan or User (see OpsLoansService).
export class CreateLoanQuoteDto {
  @ApiProperty({ example: 'Adaeze Okafor', description: 'Customer full name (audit trail only)' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  customer_name!: string;

  @ApiProperty({ example: 'adaeze@example.com', description: 'Customer email (audit trail only)' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(320)
  customer_email!: string;

  @ApiProperty({ example: 500000, description: 'Loan principal in NGN' })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  principal_ngn!: number;

  get principal_decimal(): Decimal {
    return new Decimal(this.principal_ngn);
  }
}
