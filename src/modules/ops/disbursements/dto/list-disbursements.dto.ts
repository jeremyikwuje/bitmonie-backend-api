import { IsOptional, IsEnum, IsString, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { DisbursementStatus } from '@prisma/client';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ListDisbursementsDto {
  @ApiPropertyOptional({
    enum: DisbursementStatus,
    description: 'Filter by status. Defaults to ON_HOLD — the queue ops actively triages.',
  })
  @IsOptional()
  @IsEnum(DisbursementStatus)
  status?: DisbursementStatus;

  @ApiPropertyOptional({
    description: 'Cursor (disbursement.id) — return rows older than this row in the chosen status.',
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ description: 'Page size, 1–100. Defaults to 25.', minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
