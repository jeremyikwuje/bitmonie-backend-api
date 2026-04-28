import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class OpsStartEnrolmentDto {
  @ApiProperty({ description: 'enrolment_token surfaced by login when totp_enabled=false' })
  @IsString()
  enrolment_token!: string;
}
