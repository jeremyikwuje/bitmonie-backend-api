import { ApiProperty } from '@nestjs/swagger';
import { AssetPair } from '@prisma/client';

export class RateItemDto {
  @ApiProperty({ enum: AssetPair, example: 'SAT_NGN' })
  pair!: AssetPair;

  @ApiProperty({ description: 'NGN buy rate per 1 unit of asset (6 decimal places)', example: '0.001600' })
  rate_buy!: string;

  @ApiProperty({ description: 'NGN sell rate per 1 unit of asset (6 decimal places)', example: '0.001580' })
  rate_sell!: string;

  @ApiProperty({ description: 'ISO-8601 UTC timestamp of when rate was fetched' })
  fetched_at!: string;
}
