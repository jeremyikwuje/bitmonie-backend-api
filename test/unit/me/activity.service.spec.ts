import { Test, TestingModule } from '@nestjs/testing';
import { LoanStatus, StatusTrigger } from '@prisma/client';
import { ActivityService } from '@/modules/me/activity.service';
import { PrismaService } from '@/database/prisma.service';
import { LoanReasonCodes } from '@/common/constants';

const USER_ID = 'user-uuid';
const LOAN_ID = '11111111-2222-3333-4444-555555555555';

function make_prisma() {
  return {
    loanStatusLog: { findMany: jest.fn().mockResolvedValue([]) },
    inflow: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

function make_loan_log(overrides: Partial<{
  id: string;
  reason_code: string;
  created_at: Date;
  to_status: LoanStatus;
  metadata: Record<string, unknown> | null;
  loan: unknown;
}> = {}) {
  return {
    id: overrides.id ?? 'log-uuid-1',
    loan_id: LOAN_ID,
    user_id: USER_ID,
    from_status: LoanStatus.PENDING_COLLATERAL,
    to_status: overrides.to_status ?? LoanStatus.ACTIVE,
    triggered_by: StatusTrigger.SYSTEM,
    triggered_by_id: null,
    reason_code: overrides.reason_code ?? LoanReasonCodes.COLLATERAL_CONFIRMED,
    reason_detail: null,
    metadata: overrides.metadata ?? null,
    created_at: overrides.created_at ?? new Date('2026-05-05T13:10:00Z'),
    loan: overrides.loan ?? {
      id: LOAN_ID,
      principal_ngn: { toString: () => '500000' },
      collateral_amount_sat: 1_500_000n,
      disbursement_account: { provider_name: 'GTBank', account_unique: '0123456789' },
    },
  };
}

describe('ActivityService', () => {
  let service: ActivityService;
  let prisma: ReturnType<typeof make_prisma>;

  beforeEach(async () => {
    prisma = make_prisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ActivityService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(ActivityService);
  });

  it('returns empty page + null cursor when both sources are empty', async () => {
    const result = await service.getPage(USER_ID, undefined, 20);
    expect(result.items).toEqual([]);
    expect(result.next_cursor).toBeNull();
  });

  it('builds a LOAN_DISBURSED item with bank + masked account in the title', async () => {
    prisma.loanStatusLog.findMany.mockResolvedValue([
      make_loan_log({ reason_code: LoanReasonCodes.DISBURSEMENT_CONFIRMED }),
    ]);

    const result = await service.getPage(USER_ID, undefined, 20);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      type: 'LOAN_DISBURSED',
      loan_id: LOAN_ID,
      link: `/loans/${LOAN_ID}`,
    });
    expect(result.items[0].title).toContain('GTBank');
    expect(result.items[0].title).toContain('****6789');
    // We paid the customer → floor rounding
    expect(result.items[0].amount_ngn).toBe('500000');
  });

  it('sums applied amounts on REPAYMENT_RECEIVED and uses ceil for the title', async () => {
    prisma.loanStatusLog.findMany.mockResolvedValue([
      make_loan_log({
        reason_code: LoanReasonCodes.REPAYMENT_PARTIAL_NGN,
        metadata: {
          applied_to_principal: '50000.00',
          applied_to_interest: '30000.00',
          applied_to_custody: '20000.00',
        },
      }),
    ]);

    const result = await service.getPage(USER_ID, undefined, 20);

    expect(result.items[0].type).toBe('REPAYMENT_RECEIVED');
    expect(result.items[0].amount_ngn).toBe('100000');
    expect(result.items[0].title).toContain('₦100,000');
  });

  it('emits INFLOW_RECEIVED_UNMATCHED for unmatched inflows and gates untrusted reasons out', async () => {
    prisma.inflow.findMany.mockResolvedValue([
      {
        id: 'inflow-good',
        user_id: USER_ID,
        amount: { toString: () => '15000' },
        provider_response: { payerAccountName: 'Ada' },
        created_at: new Date('2026-05-05T12:00:00Z'),
      },
      {
        id: 'inflow-untrusted',
        user_id: USER_ID,
        amount: { toString: () => '999999' },
        provider_response: { bitmonie_unmatched_reason: 'requery_mismatch' },
        created_at: new Date('2026-05-05T13:00:00Z'),
      },
    ]);

    const result = await service.getPage(USER_ID, undefined, 20);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      type: 'INFLOW_RECEIVED_UNMATCHED',
      id: 'inflow:inflow-good',
      link: '/inflows',
    });
  });

  it('orders mixed sources by occurred_at DESC and emits a stable next_cursor', async () => {
    // Hit the limit with one source — should emit a cursor.
    prisma.loanStatusLog.findMany.mockResolvedValue([
      make_loan_log({ id: 'log-newest', created_at: new Date('2026-05-05T13:00:00Z') }),
      make_loan_log({ id: 'log-mid',    created_at: new Date('2026-05-05T11:00:00Z') }),
    ]);
    prisma.inflow.findMany.mockResolvedValue([
      {
        id: 'inflow-between',
        user_id: USER_ID,
        amount: { toString: () => '10000' },
        provider_response: null,
        created_at: new Date('2026-05-05T12:00:00Z'),
      },
    ]);

    const result = await service.getPage(USER_ID, undefined, 2);

    expect(result.items).toHaveLength(2);
    expect(result.items[0].id).toBe('log:log-newest');
    expect(result.items[1].id).toBe('inflow:inflow-between');
    // log_rows length === limit → there might be more → cursor non-null
    expect(result.next_cursor).not.toBeNull();
  });

  it('round-trips the cursor without re-emitting the boundary row', async () => {
    // First page
    prisma.loanStatusLog.findMany.mockResolvedValueOnce([
      make_loan_log({ id: 'log-A', created_at: new Date('2026-05-05T13:00:00Z') }),
    ]);
    prisma.inflow.findMany.mockResolvedValueOnce([]);
    const first = await service.getPage(USER_ID, undefined, 1);
    expect(first.next_cursor).toBeTruthy();

    // Second page — cursor should be passed through to both findMany calls'
    // where clauses. We just verify that decoding doesn't blow up + the call
    // proceeds (returns empty since we mocked nothing).
    const second = await service.getPage(USER_ID, first.next_cursor!, 1);
    expect(second.items).toEqual([]);
    expect(second.next_cursor).toBeNull();

    // The cursor was decoded into a where filter — both queries should have
    // been called with an OR clause containing cursor.occurred_at.
    const log_call = prisma.loanStatusLog.findMany.mock.calls[1][0];
    expect(log_call.where).toMatchObject({
      OR: expect.arrayContaining([
        expect.objectContaining({ created_at: { lt: expect.any(Date) } }),
      ]),
    });
  });

  it('rejects malformed cursors with 400', async () => {
    await expect(service.getPage(USER_ID, 'not-base64-or-anything', 20))
      .rejects.toMatchObject({ status: 400 });
  });
});
