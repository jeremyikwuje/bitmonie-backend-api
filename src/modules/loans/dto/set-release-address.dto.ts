import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class SetReleaseAddressDto {
  @ApiProperty({ example: 'user@blink.sv', description: 'Lightning address for collateral release' })
  // Trim before validation so a whitespace-only input becomes "" and gets
  // rejected by IsNotEmpty rather than slipping past as a "non-empty string".
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  collateral_release_address!: string;
}
