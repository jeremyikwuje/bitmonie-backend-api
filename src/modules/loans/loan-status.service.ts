import { Injectable } from '@nestjs/common';
import { LoanStatus, StatusTrigger } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { LoanInvalidTransitionException } from '@/common/errors/bitmonie.errors';

// Forward-only state machine: from → valid destinations
const VALID_TRANSITIONS: Partial<Record<LoanStatus, LoanStatus[]>> = {
  [LoanStatus.PENDING_COLLATERAL]: [LoanStatus.ACTIVE, LoanStatus.EXPIRED, LoanStatus.CANCELLED],
  [LoanStatus.ACTIVE]:             [LoanStatus.REPAID, LoanStatus.LIQUIDATED],
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
      this._assertValidTransition(from_status, to_status);
      await tx.loan.update({
        where: { id: loan_id },
        data: { status: to_status },
      });
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

  private _assertValidTransition(from: LoanStatus, to: LoanStatus): void {
    const allowed = VALID_TRANSITIONS[from] ?? [];
    if (!allowed.includes(to)) {
      throw new LoanInvalidTransitionException({ from_status: from, to_status: to });
    }
  }
}
