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

  // ── self-transitions (CLAUDE.md §5.4) ─────────────────────────────────────────

  describe('self-transitions', () => {
    const allowed_self_transitions: Array<[LoanStatus, string]> = [
      [LoanStatus.ACTIVE, 'REPAYMENT_PARTIAL_NGN'],
      [LoanStatus.ACTIVE, 'COLLATERAL_TOPPED_UP'],
      [LoanStatus.REPAID, 'COLLATERAL_RELEASED'],
    ];

    for (const [status, reason] of allowed_self_transitions) {
      it(`allows ${status} → ${status} with reason_code=${reason}`, async () => {
        const tx = make_tx();
        await expect(
          service.transition(tx as never, {
            loan_id:      LOAN_ID,
            user_id:      USER_ID,
            from_status:  status,
            to_status:    status,
            triggered_by: StatusTrigger.SYSTEM,
            reason_code:  reason,
          }),
        ).resolves.not.toThrow();
      });

      it(`writes a status_log row but does NOT update loan.status on ${status} → ${status} (${reason})`, async () => {
        const tx = make_tx();
        await service.transition(tx as never, {
          loan_id:      LOAN_ID,
          user_id:      USER_ID,
          from_status:  status,
          to_status:    status,
          triggered_by: StatusTrigger.SYSTEM,
          reason_code:  reason,
        });
        expect(tx.loan.update).not.toHaveBeenCalled();
        expect(tx.loanStatusLog.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            from_status: status,
            to_status:   status,
            reason_code: reason,
          }),
        });
      });
    }

    const rejected_self_transitions: Array<[LoanStatus, string]> = [
      // Right status, wrong reason_code
      [LoanStatus.ACTIVE, 'REPAYMENT_COMPLETED'],
      [LoanStatus.REPAID, 'REPAYMENT_PARTIAL_NGN'],
      // Status with no allowed self-transition reasons at all
      [LoanStatus.PENDING_COLLATERAL, 'LOAN_CREATED'],
      [LoanStatus.LIQUIDATED, 'COLLATERAL_RELEASED'],
      [LoanStatus.EXPIRED, 'INVOICE_EXPIRED'],
      [LoanStatus.CANCELLED, 'CUSTOMER_CANCELLED'],
    ];

    for (const [status, reason] of rejected_self_transitions) {
      it(`rejects ${status} → ${status} with reason_code=${reason}`, async () => {
        const tx = make_tx();
        await expect(
          service.transition(tx as never, {
            loan_id:      LOAN_ID,
            user_id:      USER_ID,
            from_status:  status,
            to_status:    status,
            triggered_by: StatusTrigger.SYSTEM,
            reason_code:  reason,
          }),
        ).rejects.toThrow(LoanInvalidTransitionException);
      });
    }
  });
});
