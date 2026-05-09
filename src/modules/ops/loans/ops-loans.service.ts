import { Injectable } from '@nestjs/common';
import { LoanStatus, StatusTrigger } from '@prisma/client';
import Decimal from 'decimal.js';
import { PrismaService } from '@/database/prisma.service';
import { OpsAuditService } from '@/modules/ops/auth/ops-audit.service';
import { OPS_ACTION, OPS_TARGET_TYPE } from '@/common/constants/ops-actions';
import {
  LoanReasonCodes,
  MIN_LIQUIDATION_RATE_FRACTION,
} from '@/common/constants';
import {
  CollateralReleaseNotEligibleException,
  CollateralReleaseSendFailedException,
  LoanNotFoundException,
  LoanNotLiquidatedException,
  LiquidationNotBadRateException,
} from '@/common/errors/bitmonie.errors';
import { CollateralReleaseService } from '@/modules/loans/collateral-release.service';
import type { OpsAuditContext } from '@/modules/ops/disbursements/ops-disbursements.service';

// Reverses a LIQUIDATED loan back to ACTIVE when the liquidation was triggered
// by a glitched price feed (`liquidation_rate_actual < sat_ngn_rate_at_creation
// × MIN_LIQUIDATION_RATE_FRACTION`). This is the *only* place LIQUIDATED → ACTIVE
// is permitted; CLAUDE.md §5.4 forbids backward transitions everywhere else, so
// this service writes the loan update + status log + audit row directly in one
// Prisma transaction rather than going through LoanStatusService (which would
// reject the transition).
//
// The bad-rate signature is verified server-side — ops cannot restore an
// arbitrary liquidation. If the liquidation rate is plausibly market-driven
// (≥ sanity floor), the request is refused with LIQUIDATION_NOT_BAD_RATE.
//
// Note: an in-flight or already-completed `BlinkProvider.swapBtcToUsd` against
// the seized BTC is NOT unwound by this endpoint — that swap runs after the
// liquidation tx commits and is fire-and-forget. Ops must square Bitmonie's
// internal wallet position separately. The customer-facing loan record is whole
// regardless.

@Injectable()
export class OpsLoansService {
  constructor(
    private readonly prisma:    PrismaService,
    private readonly ops_audit: OpsAuditService,
    private readonly collateral_release: CollateralReleaseService,
  ) {}

  async restoreFromBadLiquidation(
    loan_id: string,
    reason:  string,
    ctx:     OpsAuditContext,
  ): Promise<void> {
    const loan = await this.prisma.loan.findUnique({
      where:  { id: loan_id },
      select: {
        id:                       true,
        user_id:                  true,
        status:                   true,
        liquidated_at:            true,
        liquidation_rate_actual:  true,
        sat_ngn_rate_at_creation: true,
      },
    });
    if (!loan) throw new LoanNotFoundException();

    if (loan.status !== LoanStatus.LIQUIDATED) {
      throw new LoanNotLiquidatedException({ status: loan.status });
    }

    const rate_at_creation = new Decimal(loan.sat_ngn_rate_at_creation.toString());
    const sanity_floor     = rate_at_creation.mul(MIN_LIQUIDATION_RATE_FRACTION);
    const actual_rate      = loan.liquidation_rate_actual
      ? new Decimal(loan.liquidation_rate_actual.toString())
      : null;

    // Bad-rate signature: rate at liquidation must be present and below the
    // per-loan sanity floor. A null rate counts as bad — the worker stamped
    // it as part of the same broken-feed cascade.
    const is_bad_rate = actual_rate === null || actual_rate.lt(sanity_floor);
    if (!is_bad_rate) {
      throw new LiquidationNotBadRateException({
        liquidation_rate_actual:  actual_rate ? actual_rate.toFixed(6) : null,
        sat_ngn_rate_at_creation: rate_at_creation.toFixed(6),
        sanity_floor:             sanity_floor.toFixed(6),
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.loan.update({
        where: { id: loan.id },
        data: {
          status:                  LoanStatus.ACTIVE,
          liquidated_at:           null,
          liquidation_rate_actual: null,
        },
      });

      await tx.loanStatusLog.create({
        data: {
          loan_id:        loan.id,
          user_id:        loan.user_id,
          from_status:    LoanStatus.LIQUIDATED,
          to_status:      LoanStatus.ACTIVE,
          triggered_by:   StatusTrigger.SYSTEM,
          triggered_by_id: ctx.ops_user_id,
          reason_code:    LoanReasonCodes.LIQUIDATION_REVERSED_BAD_RATE,
          reason_detail:  reason,
          metadata: {
            original_liquidation_rate_actual: actual_rate ? actual_rate.toString() : null,
            original_liquidated_at:           loan.liquidated_at?.toISOString() ?? null,
            sat_ngn_rate_at_creation:         rate_at_creation.toString(),
            min_liquidation_rate_fraction:    MIN_LIQUIDATION_RATE_FRACTION.toString(),
          },
        },
      });

      await this.ops_audit.write(tx, {
        ops_user_id: ctx.ops_user_id,
        action:      OPS_ACTION.LOAN_RESTORE_BAD_LIQUIDATION,
        target_type: OPS_TARGET_TYPE.LOAN,
        target_id:   loan.id,
        details: {
          previous_status:                 loan.status,
          original_liquidation_rate_actual: actual_rate ? actual_rate.toString() : null,
          original_liquidated_at:          loan.liquidated_at?.toISOString() ?? null,
          sanity_floor:                    sanity_floor.toFixed(6),
          reason,
        },
        request_id:  ctx.request_id,
        ip_address:  ctx.ip_address,
      });
    });
  }

  // Manual collateral release. Used when the auto path (post-commit fire-
  // and-forget in creditInflow) is wedged — e.g. provider outage at the
  // moment the loan was marked REPAID, or the customer reports their SAT
  // never arrived. Drives the same CollateralReleaseService the worker and
  // the post-commit hand-off use, so all three converge on identical state.
  //
  // Audit-then-state pattern (mirrors retry/cancel for disbursements): the
  // ops_audit row records that ops triggered a release, written in its own
  // tx so the intent is captured regardless of whether the send attempt
  // ultimately succeeds. The release itself runs after the audit commits.
  async releaseCollateral(
    loan_id: string,
    ctx:     OpsAuditContext,
  ): Promise<{ status: string; reference: string | null; error?: string }> {
    const loan = await this.prisma.loan.findUnique({
      where:  { id: loan_id },
      select: {
        id:                           true,
        status:                       true,
        collateral_release_address:   true,
        collateral_released_at:       true,
        collateral_release_reference: true,
      },
    });
    if (!loan) throw new LoanNotFoundException();

    await this.prisma.$transaction(async (tx) => {
      await this.ops_audit.write(tx, {
        ops_user_id: ctx.ops_user_id,
        action:      OPS_ACTION.LOAN_RELEASE_COLLATERAL,
        target_type: OPS_TARGET_TYPE.LOAN,
        target_id:   loan.id,
        details: {
          previous_status:                       loan.status,
          collateral_release_address:            loan.collateral_release_address,
          previous_collateral_released_at:       loan.collateral_released_at?.toISOString() ?? null,
          previous_collateral_release_reference: loan.collateral_release_reference,
        },
        request_id:  ctx.request_id,
        ip_address:  ctx.ip_address,
      });
    });

    const result = await this.collateral_release.releaseForLoan(loan.id);

    switch (result.status) {
      case 'released':
        return { status: 'released', reference: result.reference };
      case 'already_released':
        return { status: 'already_released', reference: result.reference };
      case 'in_flight':
        return { status: 'in_flight', reference: null };
      case 'not_eligible':
        throw new CollateralReleaseNotEligibleException(result.reason);
      case 'send_failed':
        throw new CollateralReleaseSendFailedException(result.error);
    }
  }
}
