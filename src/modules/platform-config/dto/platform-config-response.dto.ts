import { ApiProperty } from '@nestjs/swagger';
import { LoansConfigDto } from './loans-config.dto';

export class PlatformConfigResponseDto {
  @ApiProperty({ type: LoansConfigDto })
  loans!: LoansConfigDto;
}
