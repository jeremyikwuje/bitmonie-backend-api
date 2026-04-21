import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNumber, IsPositive, Max, Min } from 'class-validator';
import { MAX_LOAN_DURATION_DAYS, MIN_LOAN_DURATION_DAYS } from '@/common/constants';

export class CalculateLoanDto {
  @ApiProperty({ example: 300000 })
  @IsNumber()
  @IsPositive()
  principal_ngn!: number;

  @ApiProperty({ example: 7 })
  @IsInt()
  @Min(MIN_LOAN_DURATION_DAYS)
  @Max(MAX_LOAN_DURATION_DAYS)
  duration_days!: number;
}
