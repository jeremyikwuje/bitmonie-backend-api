import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

// Passwordless signup. The only field is email — verification happens via
// the OTP delivered to that inbox. KYC + names are collected later through
// the profile / KYC modules, never here.
export class SignupDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email!: string;
}
