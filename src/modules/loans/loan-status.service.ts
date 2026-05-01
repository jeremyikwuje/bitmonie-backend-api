import { Injectable } from '@nestjs/common';
import { LoanStatus, StatusTrigger } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { LoanReasonCodes } from '@/common/constants';
import { LoanInvalidTransitionException } from '@/common/errors/bitmonie.errors';

// Forward-only state machine: from → valid destinations.
const VALID_TRANSITIONS: Partial<Record<LoanStatus, LoanStatus[]>> = {
  [LoanStatus.PENDING_COLLATERAL]: [LoanStatus.ACTIVE, LoanStatus.EXPIRED, LoanStatus.CANCELLED],
  [LoanStatus.ACTIVE]:             [LoanStatus.REPAID, LoanStatus.LIQUIDATED],
};

// Self-transitions (from === to) are exceptions to forward-only — required
// for state-changing events that don't move status (CLAUDE.md §5.4). Each
// allowed self-transition lists the specific reason codes that authorize it.
// Anything not in this map throws LoanInvalidTransitionException.
const SELF_TRANSITION_REASONS: Partial<Record<LoanStatus, ReadonlySet<string>>> = {
  [LoanStatus.ACTIVE]: new Set([
    LoanReasonCodes.REPAYMENT_PARTIAL_NGN,
    LoanReasonCodes.COLLATERAL_TOPPED_UP,
  ]),
  [LoanStatus.REPAID]: new Set([
    LoanReasonCodes.COLLATERAL_RELEASED,
  ]),
};

export interface TransitionParams {
  loan_id:          string;
  user_id:          string;
  from_status:      LoanStatus | null;   // null for initial PENDING_COLLATERAL creation
  to_status:        LoanStatus;
  triggered_by:     StatusTrigger;
  triggered_by_id?: string;
  reason_code:      string;
  reason_detail?:   string;
  metadata?:        Record<string, unknown>;
}

type TxClient = Prisma.TransactionClient;

@Injectable()
export class LoanStatusService {
  async transition(tx: TxClient, params: TransitionParams): Promise<void> {
    const { loan_id, user_id, from_status, to_status } = params;

    if (from_status !== null) {
      this._assertValidTransition(from_status, to_status, params.reason_code);
      // Skip the loan.status UPDATE on a self-transition — status hasn't
      // moved, only the side-effect (repayment / top-up / release) has.
      // The status_log row below is still required (§5.4).
      if (from_status !== to_status) {
        await tx.loan.update({
          where: { id: loan_id },
          data: { status: to_status },
        });
      }
    }

    await tx.loanStatusLog.create({
      data: {
        loan_id,
        user_id,
        from_status:      from_status ?? undefined,
        to_status,
        triggered_by:     params.triggered_by,
        triggered_by_id:  params.triggered_by_id,
        reason_code:      params.reason_code,
        reason_detail:    params.reason_detail,
        metadata:         params.metadata as never,
      },
    });
  }

  private _assertValidTransition(from: LoanStatus, to: LoanStatus, reason_code: string): void {
    if (from === to) {
      const allowed_reasons = SELF_TRANSITION_REASONS[from];
      if (!allowed_reasons || !allowed_reasons.has(reason_code)) {
        throw new LoanInvalidTransitionException({ from_status: from, to_status: to });
      }
      return;
    }
    const allowed = VALID_TRANSITIONS[from] ?? [];
    if (!allowed.includes(to)) {
      throw new LoanInvalidTransitionException({ from_status: from, to_status: to });
    }
  }
}
