import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class OpsEnrol2faDto {
  @ApiProperty({ description: 'enrolment_token surfaced by login when totp_enabled=false' })
  @IsString()
  enrolment_token!: string;

  @ApiProperty({ example: '123456', description: 'TOTP code from authenticator app' })
  @IsString()
  @Length(6, 6)
  totp_code!: string;
}
