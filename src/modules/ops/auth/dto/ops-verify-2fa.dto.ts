import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class OpsVerify2faDto {
  @ApiProperty({ description: 'challenge_id returned by step 1 of /v1/ops/auth/login' })
  @IsString()
  challenge_id!: string;

  @ApiProperty({ example: '123456', description: 'TOTP code from authenticator app' })
  @IsString()
  @Length(6, 6)
  totp_code!: string;
}
