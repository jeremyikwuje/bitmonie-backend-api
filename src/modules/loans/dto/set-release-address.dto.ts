import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

export class SetReleaseAddressDto {
  @ApiProperty({ example: 'user@blink.sv', description: 'Lightning address for collateral release' })
  // Trim before validation so a whitespace-only input becomes "" and gets
  // rejected by IsNotEmpty rather than slipping past as a "non-empty string".
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  collateral_release_address!: string;

  @ApiPropertyOptional({
    example: '482917',
    description:
      '6-digit email OTP. REQUIRED when changing an existing release address; ' +
      'first-set (NULL → value) does not need it. Request the OTP via ' +
      'POST /v1/loans/:id/release-address/request-change-otp.',
  })
  @IsOptional()
  @IsString()
  @Length(6, 6)
  email_otp?: string;

  @ApiPropertyOptional({
    example: '142857',
    description:
      '6-digit transaction PIN. REQUIRED when changing an existing release ' +
      'address — submit either this OR `totp_code` (not both). The user must ' +
      'have at least one of {transaction PIN, TOTP} configured for the change ' +
      'to be accepted at all.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9]{6}$/, { message: 'transaction_pin must be exactly 6 digits' })
  transaction_pin?: string;

  @ApiPropertyOptional({
    example: '293041',
    description:
      '6-digit TOTP code from the customer\'s authenticator app. REQUIRED when ' +
      'changing an existing release address — submit either this OR ' +
      '`transaction_pin` (not both).',
  })
  @IsOptional()
  @IsString()
  @Length(6, 6)
  totp_code?: string;
}
