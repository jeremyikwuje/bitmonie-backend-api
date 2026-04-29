import { IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RestoreFromBadLiquidationDto {
  @ApiProperty({
    description:
      'Why ops is reversing the liquidation. Stamped onto loan_status_logs.reason_detail and mirrored into the ops_audit_logs row.',
    minLength: 4,
    maxLength: 500,
  })
  @IsString()
  @MinLength(4)
  @MaxLength(500)
  reason!: string;
}
