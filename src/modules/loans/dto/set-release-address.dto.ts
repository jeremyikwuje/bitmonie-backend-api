import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class SetReleaseAddressDto {
  @ApiProperty({ example: 'user@blink.sv', description: 'Lightning address for collateral release' })
  @IsString()
  @MaxLength(512)
  collateral_release_address!: string;
}
