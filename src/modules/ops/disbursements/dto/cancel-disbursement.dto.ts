import { IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CancelDisbursementDto {
  @ApiProperty({
    description:
      'Why ops is terminally cancelling. Stored on the disbursement row and mirrored into the ops_audit_logs row for this action.',
    minLength: 4,
    maxLength: 500,
  })
  @IsString()
  @MinLength(4)
  @MaxLength(500)
  reason!: string;
}
