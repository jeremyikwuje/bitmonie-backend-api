import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, IsPositive } from 'class-validator';

export class CalculateLoanDto {
  @ApiProperty({ example: 300000 })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  principal_ngn!: number;
}
