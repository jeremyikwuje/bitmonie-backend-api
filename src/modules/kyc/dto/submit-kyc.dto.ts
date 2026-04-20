import { IsEnum, IsNotEmpty, IsOptional, IsString, Length, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { KycIdType } from '@prisma/client';

export class SubmitKycDto {
  @ApiProperty({ enum: KycIdType, description: 'Identity document type' })
  @IsEnum(KycIdType)
  id_type!: KycIdType;

  @ApiProperty({ description: 'Identity number (BVN 11 digits, NIN 11 digits, Passport 6–9 chars, Driver\'s License up to 20 chars)' })
  @IsString()
  @IsNotEmpty()
  @Length(6, 20)
  id_number!: string;

  @ApiProperty({ description: 'First name exactly as registered on the ID document' })
  @IsString()
  @IsNotEmpty()
  @Length(1, 100)
  first_name!: string;

  @ApiProperty({ description: 'Middle name, if any, exactly as registered on the ID document' })
  @IsString()
  @IsOptional()
  @Length(1, 100)
  middle_name?: string;

  @ApiProperty({ description: 'Last name exactly as registered on the ID document' })
  @IsString()
  @IsNotEmpty()
  @Length(1, 100)
  last_name!: string;

  @ApiProperty({ description: 'Date of birth in YYYY-MM-DD format' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date_of_birth must be in YYYY-MM-DD format' })
  date_of_birth!: string;
}
