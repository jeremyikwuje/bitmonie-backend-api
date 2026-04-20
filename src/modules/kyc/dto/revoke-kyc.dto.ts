import { IsInt, Min, Max } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RevokeKycDto {
  @ApiProperty({ description: 'Tier to revert to. 0 = full reset. Tiers above this value are deleted.' })
  @IsInt()
  @Min(0)
  @Max(3)
  target_tier!: number;
}
