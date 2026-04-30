import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class ApplyInflowDto {
  @ApiProperty({
    description: 'The ACTIVE loan to apply this inflow to.',
    format:      'uuid',
    example:     'loan-uuid-001',
  })
  @IsUUID()
  loan_id!: string;
}
