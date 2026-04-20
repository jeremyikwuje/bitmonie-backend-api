import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { DisbursementAccountKind } from '@prisma/client';

export class AddDisbursementAccountDto {
  @ApiProperty({ enum: DisbursementAccountKind })
  @IsEnum(DisbursementAccountKind)
  kind!: DisbursementAccountKind;

  @ApiProperty({ example: 'GTBank' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  provider_name!: string;

  @ApiProperty({ description: 'Bank code (NIBSS sort code) for BANK kind; MTN/AIRTEL/GLO for MOBILE_MONEY; address for CRYPTO_ADDRESS', example: '058' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  provider_code!: string;

  @ApiProperty({ description: 'Account number / phone number / crypto address', example: '0123456789' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  account_unique!: string;

  @ApiPropertyOptional({ description: 'Memo / destination tag for crypto', example: '12345' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  account_unique_tag?: string;

  @ApiPropertyOptional({ description: 'Friendly label', example: 'My GTBank savings' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;
}
