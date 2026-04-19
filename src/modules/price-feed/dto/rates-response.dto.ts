import { ApiProperty } from '@nestjs/swagger';
import { RateItemDto } from './rate-item.dto';

export class RatesResponseDto {
  @ApiProperty({ type: [RateItemDto] })
  rates: RateItemDto[] = [];
}
