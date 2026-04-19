import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsString, IsOptional, Length } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty()
  @IsString()
  password!: string;

  @ApiPropertyOptional({ example: '123456', description: 'TOTP code — required if 2FA is enabled' })
  @IsOptional()
  @IsString()
  @Length(6, 6)
  totp_code?: string;
}
