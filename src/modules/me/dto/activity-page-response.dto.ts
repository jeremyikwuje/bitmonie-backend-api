import { ApiProperty } from '@nestjs/swagger';

export type ActivityType =
  | 'LOAN_CREATED'
  | 'COLLATERAL_RECEIVED'
  | 'COLLATERAL_TOPPED_UP'
  | 'LOAN_DISBURSED'
  | 'REPAYMENT_RECEIVED'
  | 'LOAN_REPAID'
  | 'COLLATERAL_RELEASED'
  | 'LOAN_LIQUIDATED'
  | 'LOAN_EXPIRED'
  | 'LOAN_CANCELLED'
  | 'INFLOW_RECEIVED_UNMATCHED';

export class ActivityItemDto {
  @ApiProperty({ description: 'Opaque event ID, prefixed with the source table.' })
  id!: string;

  @ApiProperty({ description: 'ISO-8601 UTC.' })
  occurred_at!: string;

  @ApiProperty({
    enum: [
      'LOAN_CREATED',
      'COLLATERAL_RECEIVED',
      'COLLATERAL_TOPPED_UP',
      'LOAN_DISBURSED',
      'REPAYMENT_RECEIVED',
      'LOAN_REPAID',
      'COLLATERAL_RELEASED',
      'LOAN_LIQUIDATED',
      'LOAN_EXPIRED',
      'LOAN_CANCELLED',
      'INFLOW_RECEIVED_UNMATCHED',
    ],
  })
  type!: ActivityType;

  @ApiProperty({ description: 'Display-ready headline. Server owns this copy.' })
  title!: string;

  @ApiProperty({ required: false })
  subtitle?: string;

  @ApiProperty({ required: false, description: 'Display-ready NGN string when applicable.' })
  amount_ngn?: string;

  @ApiProperty({ required: false, description: 'SAT amount as a string when applicable.' })
  amount_sat?: string;

  @ApiProperty({ required: false, format: 'uuid' })
  loan_id?: string;

  @ApiProperty({ required: false, description: 'Client-side route to drill into.' })
  link?: string;
}

export class ActivityPageResponseDto {
  @ApiProperty({ type: [ActivityItemDto] })
  items!: ActivityItemDto[];

  @ApiProperty({
    nullable: true,
    description: 'Opaque cursor — pass back as ?cursor= to fetch the next page. null when exhausted.',
  })
  next_cursor!: string | null;
}
