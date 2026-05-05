import { ApiProperty } from '@nestjs/swagger';

export type AttentionKind =
  | 'PENDING_COLLATERAL'
  | 'OVERDUE_GRACE'
  | 'LIQUIDATION_RISK'
  | 'AWAITING_RELEASE_ADDRESS';

export class AttentionCardDto {
  @ApiProperty({ format: 'uuid' })
  loan_id!: string;

  @ApiProperty({
    enum: ['PENDING_COLLATERAL', 'OVERDUE_GRACE', 'LIQUIDATION_RISK', 'AWAITING_RELEASE_ADDRESS'],
    description: 'Why this loan needs the user. Drives the card icon + tone client-side.',
  })
  kind!: AttentionKind;

  @ApiProperty({
    description:
      'Stable integer the server computes; client sorts attention[] by this DESC ' +
      'to render the peek-stack in priority order. No fixed range — only the ordering matters.',
    example: 100,
  })
  urgency!: number;

  @ApiProperty({ description: 'Display-ready headline. Server owns this copy.' })
  title!: string;

  @ApiProperty({ description: 'Display-ready secondary line. Server owns this copy.' })
  subtitle!: string;

  @ApiProperty({
    required: false,
    description:
      'ISO-8601 deadline relevant to this card (invoice expiry for PENDING_COLLATERAL, ' +
      'grace expiry for OVERDUE_GRACE). Absent when no time pressure exists.',
    example: '2026-05-05T14:32:00Z',
  })
  expires_at?: string;
}

export class MeSummaryResponseDto {
  @ApiProperty({
    description:
      'Sum of AccrualService outstanding across all ACTIVE loans, displayed with ' +
      'displayNgn(ceil) — the same rounding policy used for repayment-side amounts. ' +
      'Empty string is never returned; "0" if the user has no outstanding.',
    example: '525000',
  })
  outstanding_ngn!: string;

  @ApiProperty({ description: 'Count of loans currently in ACTIVE.' })
  active_loan_count!: number;

  @ApiProperty({
    type: [AttentionCardDto],
    description: 'Loans that need user action, sorted by urgency DESC. Empty when nothing pending.',
  })
  attention!: AttentionCardDto[];

  @ApiProperty({
    description:
      'Number of unmatched repayment inflows the user can claim via the inflows surface. ' +
      'Drives the "you have N unmatched payments" banner on the Loans tab without ' +
      'forcing the client to fetch the full list until the user taps in.',
  })
  unmatched_inflow_count!: number;

  @ApiProperty({
    description:
      'Sum of unmatched inflow amounts, displayed with displayNgn(ceil). "0" when none.',
    example: '10000',
  })
  unmatched_inflow_total_ngn!: string;
}
