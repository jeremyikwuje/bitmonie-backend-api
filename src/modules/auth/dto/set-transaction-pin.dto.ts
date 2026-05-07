import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches, IsOptional } from 'class-validator';

// 6-digit numeric PIN. Stored as Argon2id hash. Re-using digits-only over
// alphanumerics because (a) keypad UX on mobile is non-negotiable in NG
// fintech and (b) it composes with a future "biometric unlocks PIN" UX.
const PIN_REGEX = /^[0-9]{6}$/;

export class SetTransactionPinDto {
  @ApiProperty({ example: '123456', description: 'Email OTP from POST /v1/auth/transaction-pin/request-set-otp' })
  @IsString()
  @Length(6, 6)
  email_otp!: string;

  @ApiProperty({ example: '142857', description: '6-digit numeric PIN' })
  @IsString()
  @Matches(PIN_REGEX, { message: 'transaction_pin must be exactly 6 digits' })
  transaction_pin!: string;
}

export class ChangeTransactionPinDto {
  @ApiProperty({ example: '123456', description: 'Current 6-digit PIN' })
  @IsString()
  @Matches(PIN_REGEX, { message: 'current_transaction_pin must be exactly 6 digits' })
  current_transaction_pin!: string;

  @ApiProperty({ example: '654321', description: 'Email OTP from POST /v1/auth/transaction-pin/request-change-otp' })
  @IsString()
  @Length(6, 6)
  email_otp!: string;

  @ApiProperty({ example: '142857', description: 'New 6-digit numeric PIN' })
  @IsString()
  @Matches(PIN_REGEX, { message: 'new_transaction_pin must be exactly 6 digits' })
  new_transaction_pin!: string;
}

// Disable accepts EITHER current PIN OR a TOTP code (when 2FA is enabled).
// Email OTP is always required. Validation is left to the service so we can
// surface the precise "factor required" message rather than a class-validator
// 400 that obscures intent.
export class DisableTransactionPinDto {
  @ApiProperty({ example: '123456', description: 'Email OTP from POST /v1/auth/transaction-pin/request-disable-otp' })
  @IsString()
  @Length(6, 6)
  email_otp!: string;

  @ApiProperty({ required: false, example: '123456', description: 'Current 6-digit PIN. Provide this OR totp_code.' })
  @IsOptional()
  @IsString()
  @Matches(PIN_REGEX, { message: 'current_transaction_pin must be exactly 6 digits' })
  current_transaction_pin?: string;

  @ApiProperty({ required: false, example: '123456', description: 'TOTP code from authenticator app. Provide this OR current_transaction_pin.' })
  @IsOptional()
  @IsString()
  @Length(6, 6)
  totp_code?: string;
}
