import { LoanStatus, StatusTrigger } from '@prisma/client';
import { LoanStatusService } from '@/modules/loans/loan-status.service';
import { LoanInvalidTransitionException } from '@/common/errors/bitmonie.errors';

const LOAN_ID = 'loan-uuid-001';
const USER_ID = 'user-uuid-001';

function make_tx() {
  return {
    loan:          { update: jest.fn().mockResolvedValue({}) },
    loanStatusLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

describe('LoanStatusService', () => {
  const service = new LoanStatusService();

  // ── transition ────────────────────────────────────────────────────────────────

  describe('transition', () => {
    it('creates a LoanStatusLog row in the transaction', async () => {
      const tx = make_tx();
      await service.transition(tx as never, {
        loan_id:      LOAN_ID,
        user_id:      USER_ID,
        from_status:  null,
        to_status:    LoanStatus.PENDING_COLLATERAL,
        triggered_by: StatusTrigger.CUSTOMER,
        reason_code:  'LOAN_CREATED',
      });

      expect(tx.loanStatusLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          loan_id:     LOAN_ID,
          user_id:     USER_ID,
          to_status:   LoanStatus.PENDING_COLLATERAL,
          reason_code: 'LOAN_CREATED',
        }),
      });
    });

    it('does NOT update loan.status when from_status is null (initial creation)', async () => {
      const tx = make_tx();
      await service.transition(tx as never, {
        loan_id:      LOAN_ID,
        user_id:      USER_ID,
        from_status:  null,
        to_status:    LoanStatus.PENDING_COLLATERAL,
        triggered_by: StatusTrigger.CUSTOMER,
        reason_code:  'LOAN_CREATED',
      });

      expect(tx.loan.update).not.toHaveBeenCalled();
    });

    it('updates loan.status when from_status is provided', async () => {
      const tx = make_tx();
      await service.transition(tx as never, {
        loan_id:      LOAN_ID,
        user_id:      USER_ID,
        from_status:  LoanStatus.PENDING_COLLATERAL,
        to_status:    LoanStatus.ACTIVE,
        triggered_by: StatusTrigger.COLLATERAL_WEBHOOK,
        reason_code:  'COLLATERAL_CONFIRMED',
      });

      expect(tx.loan.update).toHaveBeenCalledWith({
        where: { id: LOAN_ID },
        data:  { status: LoanStatus.ACTIVE },
      });
    });

    it('sets from_status on the log row when provided', async () => {
      const tx = make_tx();
      await service.transition(tx as never, {
        loan_id:      LOAN_ID,
        user_id:      USER_ID,
        from_status:  LoanStatus.PENDING_COLLATERAL,
        to_status:    LoanStatus.CANCELLED,
        triggered_by: StatusTrigger.CUSTOMER,
        reason_code:  'CUSTOMER_CANCELLED',
      });

      expect(tx.loanStatusLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ from_status: LoanStatus.PENDING_COLLATERAL }),
      });
    });
  });

  // ── valid transitions ─────────────────────────────────────────────────────────

  describe('valid transitions', () => {
    const valid_cases: Array<[LoanStatus, LoanStatus]> = [
      [LoanStatus.PENDING_COLLATERAL, LoanStatus.ACTIVE],
      [LoanStatus.PENDING_COLLATERAL, LoanStatus.EXPIRED],
      [LoanStatus.PENDING_COLLATERAL, LoanStatus.CANCELLED],
      [LoanStatus.ACTIVE,             LoanStatus.REPAID],
      [LoanStatus.ACTIVE,             LoanStatus.LIQUIDATED],
    ];

    for (const [from, to] of valid_cases) {
      it(`allows ${from} → ${to}`, async () => {
        const tx = make_tx();
        await expect(
          service.transition(tx as never, {
            loan_id:      LOAN_ID,
            user_id:      USER_ID,
            from_status:  from,
            to_status:    to,
            triggered_by: StatusTrigger.SYSTEM,
            reason_code:  'TEST',
          }),
        ).resolves.not.toThrow();
      });
    }
  });

  // ── invalid transitions ───────────────────────────────────────────────────────

  describe('invalid transitions (throws LoanInvalidTransitionException)', () => {
    const invalid_cases: Array<[LoanStatus, LoanStatus]> = [
      [LoanStatus.ACTIVE,      LoanStatus.PENDING_COLLATERAL],
      [LoanStatus.REPAID,      LoanStatus.ACTIVE],
      [LoanStatus.LIQUIDATED,  LoanStatus.ACTIVE],
      [LoanStatus.EXPIRED,     LoanStatus.PENDING_COLLATERAL],
      [LoanStatus.CANCELLED,   LoanStatus.PENDING_COLLATERAL],
      [LoanStatus.ACTIVE,      LoanStatus.CANCELLED],
    ];

    for (const [from, to] of invalid_cases) {
      it(`rejects ${from} → ${to}`, async () => {
        const tx = make_tx();
        await expect(
          service.transition(tx as never, {
            loan_id:      LOAN_ID,
            user_id:      USER_ID,
            from_status:  from,
            to_status:    to,
            triggered_by: StatusTrigger.SYSTEM,
            reason_code:  'TEST',
          }),
        ).rejects.toThrow(LoanInvalidTransitionException);
      });
    }
  });
});
