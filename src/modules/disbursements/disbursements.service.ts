import { Injectable } from '@nestjs/common';
import { DisbursementRail, DisbursementStatus, DisbursementType, Prisma } from '@prisma/client';
import type { Decimal } from 'decimal.js';
import { PrismaService } from '@/database/prisma.service';

export interface CreateForLoanParams {
  user_id:            string;
  source_id:          string;
  amount:             Decimal;
  currency:           string;
  disbursement_rail:  DisbursementRail;
  provider_name:      string;
  account_unique:     string;
  account_name:       string | null;
}

export interface MarkOnHoldResult {
  is_first_transition: boolean;
  on_hold_at:          Date;
}

export interface MarkCancelledParams {
  disbursement_id:        string;
  cancelled_by_ops_user_id: string;
  cancellation_reason:    string;
}

@Injectable()
export class DisbursementsService {
  constructor(private readonly prisma: PrismaService) {}

  async createForLoan(params: CreateForLoanParams) {
    return this.prisma.disbursement.create({
      data: {
        user_id:           params.user_id,
        disbursement_type: DisbursementType.LOAN,
        disbursement_rail: params.disbursement_rail,
        source_type:       DisbursementType.LOAN,
        source_id:         params.source_id,
        amount:            params.amount,
        currency:          params.currency,
        provider_name:     params.provider_name,
        account_unique:    params.account_unique,
        account_name:      params.account_name,
        status:            DisbursementStatus.PENDING,
      },
    });
  }

  async findById(id: string) {
    return this.prisma.disbursement.findFirst({
      where: { id },
      include: { outflows: true },
    });
  }

  async markProcessing(id: string) {
    return this.prisma.disbursement.update({
      where: { id },
      data: {
        status:     DisbursementStatus.PROCESSING,
        // Clear ON_HOLD bookkeeping when a retry kicks off a new attempt.
        on_hold_at:         null,
        on_hold_alerted_at: null,
      },
    });
  }

  async markSuccessful(id: string) {
    return this.prisma.disbursement.update({
      where: { id },
      data: { status: DisbursementStatus.SUCCESSFUL },
    });
  }

  // Move a disbursement to ON_HOLD after an outflow attempt has failed. Returns
  // is_first_transition so the caller (OutflowsService) knows whether to fire
  // the immediate ops alert — subsequent retries that fail again should NOT
  // re-page; they're picked up by the daily digest until ops acts.
  //
  // Conditional update: the WHERE filters out rows already in ON_HOLD so the
  // first writer "wins" the on_hold_at timestamp. Concurrent failures on the
  // same disbursement are not expected (one outflow attempt at a time, gated
  // by the has_active check in dispatch), but the conditional update keeps
  // the semantics safe regardless.
  async markOnHold(id: string, failure_reason: string): Promise<MarkOnHoldResult> {
    const now = new Date();

    const updated = await this.prisma.disbursement.updateMany({
      where: {
        id,
        status: { not: DisbursementStatus.ON_HOLD },
      },
      data: {
        status:         DisbursementStatus.ON_HOLD,
        on_hold_at:     now,
        failure_reason,
      },
    });

    if (updated.count === 1) return { is_first_transition: true, on_hold_at: now };

    // Already on hold — surface the existing on_hold_at so the caller can log
    // it but skip the immediate alert.
    const existing = await this.prisma.disbursement.findUniqueOrThrow({
      where: { id },
      select: { on_hold_at: true },
    });
    return {
      is_first_transition: false,
      on_hold_at:          existing.on_hold_at ?? now,
    };
  }

  // Mark the immediate "first-transition" alert as sent. Called by
  // OutflowsService after the email is dispatched so the digest worker
  // can avoid re-paging on the same first transition.
  async markOnHoldAlerted(id: string): Promise<void> {
    await this.prisma.disbursement.update({
      where: { id },
      data:  { on_hold_alerted_at: new Date() },
    });
  }

  // Ops-only terminal cancel. Tx-aware: the caller wraps this with the
  // ops_audit_logs row so audit + state change land in the same transaction
  // (matches OpsKycController pattern + CLAUDE.md §5.4 for loans).
  async markCancelled(params: MarkCancelledParams, tx?: Prisma.TransactionClient) {
    const client = tx ?? this.prisma;
    return client.disbursement.update({
      where: { id: params.disbursement_id },
      data: {
        status:                   DisbursementStatus.CANCELLED,
        cancelled_at:             new Date(),
        cancelled_by_ops_user_id: params.cancelled_by_ops_user_id,
        cancellation_reason:      params.cancellation_reason,
      },
    });
  }
}
