import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Length } from 'class-validator';

// Body for POST /v1/auth/login/verify-otp. Mints a session on success.
// TOTP is NOT requested at login by design — login is single-factor (email
// OTP). TOTP is reserved for transaction step-up only. The user is nudged
// to set up a transaction PIN after first login (see `transaction_pin_set`
// on /auth/me).
export class VerifyLoginOtpDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @Length(6, 6)
  otp!: string;
}
