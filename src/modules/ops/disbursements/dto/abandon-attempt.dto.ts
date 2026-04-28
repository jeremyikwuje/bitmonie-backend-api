import { IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AbandonAttemptDto {
  @ApiProperty({
    description:
      'Why ops is giving up on the in-flight outflow attempt. Stored on Outflow.failure_reason and Disbursement.failure_reason; mirrored into the ops_audit_logs row.',
    minLength: 4,
    maxLength: 500,
  })
  @IsString()
  @MinLength(4)
  @MaxLength(500)
  reason!: string;
}
