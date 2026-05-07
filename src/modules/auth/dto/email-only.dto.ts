import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

// Generic email-only payload. Used by resend-verification and login OTP
// request. We intentionally do not surface whether the email is registered
// — both endpoints always 200 to avoid leaking account existence.
export class EmailOnlyDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email!: string;
}
