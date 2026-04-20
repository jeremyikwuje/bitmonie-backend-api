import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class SetDefaultDisbursementAccountDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  account_id!: string;
}
