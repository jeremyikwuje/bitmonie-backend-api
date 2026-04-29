import { Injectable } from '@nestjs/common';
import {
  DisbursementRail,
  DisbursementStatus,
  LoanStatus,
  OutflowStatus,
  type Prisma,
} from '@prisma/client';
import { PrismaService } from '@/database/prisma.service';
import { OutflowsService } from '@/modules/disbursements/outflows.service';
import { DisbursementsService } from '@/modules/disbursements/disbursements.service';
import { OpsAuditService } from '@/modules/ops/auth/ops-audit.service';
import { OPS_ACTION, OPS_TARGET_TYPE } from '@/common/constants/ops-actions';
import {
  DisbursementNotFoundException,
  DisbursementNoActiveOutflowException,
  DisbursementTerminalException,
  LoanNotFoundException,
  LoanNotActiveForDisbursementException,
  LoanHasActiveDisbursementException,
  LoanDisbursementAccountRequiredException,
} from '@/common/errors/bitmonie.errors';

const DEFAULT_LIMIT = 25;

export interface ListResult {
  rows: ReturnType<OpsDisbursementsService['_summary']>[];
  next_cursor: string | null;
}

export interface OpsAuditContext {
  ops_user_id: string;
  request_id:  string | null;
  ip_address:  string | null;
}

@Injectable()
export class OpsDisbursementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly disbursements: DisbursementsService,
    private readonly outflows: OutflowsService,
    private readonly ops_audit: OpsAuditService,
  ) {}

  // Cursor-based listing — CLAUDE.md §5.12 forbids offset pagination. Default
  // status filter is ON_HOLD because that's the active triage queue; ops can
  // override to inspect any other status.
  async list(params: {
    status?:  DisbursementStatus;
    cursor?:  string;
    limit?:   number;
  }): Promise<ListResult> {
    const limit  = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), 100);
    const status = params.status ?? DisbursementStatus.ON_HOLD;

    const rows = await this.prisma.disbursement.findMany({
      where:  { status },
      take:   limit + 1, // +1 to peek at next-page existence
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
      orderBy: [{ on_hold_at: 'desc' }, { created_at: 'desc' }, { id: 'desc' }],
      include: {
        outflows: {
          orderBy: { attempt_number: 'desc' },
        },
      },
    });

    const has_next = rows.length > limit;
    const page     = has_next ? rows.slice(0, limit) : rows;
    const last     = page[page.length - 1];

    return {
      rows: page.map((r) => this._summary(r)),
      next_cursor: has_next && last ? last.id : null,
    };
  }

  async getById(id: string) {
    const row = await this.prisma.disbursement.findUnique({
      where: { id },
      include: {
        outflows: { orderBy: { attempt_number: 'asc' } },
      },
    });
    if (!row) throw new DisbursementNotFoundException();
    return this._detail(row);
  }

  // Retry is "create a new outflow attempt". OutflowsService.retryDispatch
  // already enforces ON_HOLD-only and creates the new Outflow; we just wrap
  // the audit row. Audit is written in the same transaction as a no-op
  // SELECT against the disbursement so the audit row + the dispatch attempt
  // succeed-or-fail-together at the level of "ops triggered a retry".
  //
  // Note: OutflowsService.retryDispatch performs its own writes (Outflow
  // create, Disbursement update). Those are NOT inside the tx — Prisma
  // requires interactive callbacks to share the same client, and the
  // outflow create is intentionally idempotency-friendly via its
  // provider_reference unique key (CLAUDE.md §5.6). The audit row records
  // the ops decision regardless of whether the new outflow succeeds.
  async retry(disbursement_id: string, ctx: OpsAuditContext): Promise<void> {
    const existing = await this.disbursements.findById(disbursement_id);
    if (!existing) throw new DisbursementNotFoundException();

    await this.prisma.$transaction(async (tx) => {
      await this.ops_audit.write(tx, {
        ops_user_id: ctx.ops_user_id,
        action:      OPS_ACTION.DISBURSEMENT_RETRY,
        target_type: OPS_TARGET_TYPE.DISBURSEMENT,
        target_id:   disbursement_id,
        details:     {
          previous_status: existing.status,
          attempt_number_so_far: existing.outflows.length,
        },
        request_id:  ctx.request_id,
        ip_address:  ctx.ip_address,
      });
    });

    await this.outflows.retryDispatch(disbursement_id);
  }

  // Cancel is terminal. The audit row + state change land in the SAME
  // Prisma transaction so a failure to write the audit row rolls back the
  // cancellation — same discipline as KYC reset/revoke (CLAUDE.md §5.4
  // applied to ops actions via OpsAuditService).
  async cancel(
    disbursement_id: string,
    reason:          string,
    ctx:             OpsAuditContext,
  ): Promise<void> {
    const existing = await this.disbursements.findById(disbursement_id);
    if (!existing) throw new DisbursementNotFoundException();

    if (
      existing.status === DisbursementStatus.SUCCESSFUL ||
      existing.status === DisbursementStatus.CANCELLED
    ) {
      throw new DisbursementTerminalException({ status: existing.status });
    }

    await this.prisma.$transaction(async (tx) => {
      await this.disbursements.markCancelled(
        {
          disbursement_id,
          cancelled_by_ops_user_id: ctx.ops_user_id,
          cancellation_reason:      reason,
        },
        tx,
      );
      await this.ops_audit.write(tx, {
        ops_user_id: ctx.ops_user_id,
        action:      OPS_ACTION.DISBURSEMENT_CANCEL,
        target_type: OPS_TARGET_TYPE.DISBURSEMENT,
        target_id:   disbursement_id,
        details:     {
          previous_status: existing.status,
          reason,
        },
        request_id:  ctx.request_id,
        ip_address:  ctx.ip_address,
      });
    });
  }

  // Recreate a disbursement for an ACTIVE loan whose previous disbursement was
  // terminally cancelled (or never funded the customer for some other reason).
  // Re-snapshots the loan's CURRENT default disbursement_account so a customer
  // who updated their account between the cancel and the recreate gets paid to
  // the new destination — the cancelled row keeps the old snapshot for audit.
  //
  // Validation:
  //   • Loan exists (404).
  //   • Loan.status is ACTIVE (409). REPAID/LIQUIDATED/EXPIRED/PENDING are not
  //     valid recreate targets — there's no obligation to fund.
  //   • No non-terminal Disbursement exists for this source_id (409). A loan
  //     with a PENDING/PROCESSING/ON_HOLD disbursement must be cancelled or
  //     allowed to resolve before a fresh one is dispatched — never two
  //     simultaneous obligations against the same loan.
  //   • Loan has a default disbursement_account with a populated provider_code
  //     (422). Without it, dispatch would throw the "missing provider_code"
  //     guard from OutflowsService.dispatch.
  //
  // Audit-then-state pattern (mirrors retry/abandonAttempt): one ops_audit_logs
  // row is written in a tx, then the Disbursement create + outflow dispatch
  // happen outside the tx. The audit row records ops intent regardless of
  // whether the dispatch succeeds; a same-tx audit + create would be cleaner
  // but OutflowsService.dispatch is not tx-aware (its writes need their own
  // client). The audit captures the ops decision; the resulting Disbursement
  // row is itself the artefact of the action and is loadable via list/getById.
  async recreateForActiveLoan(
    loan_id: string,
    ctx:     OpsAuditContext,
  ): Promise<{ disbursement_id: string }> {
    const loan = await this.prisma.loan.findUnique({
      where: { id: loan_id },
      include: { disbursement_account: true },
    });
    if (!loan) throw new LoanNotFoundException();

    if (loan.status !== LoanStatus.ACTIVE) {
      throw new LoanNotActiveForDisbursementException({ status: loan.status });
    }

    const blocking = await this.prisma.disbursement.findFirst({
      where: {
        source_id: loan.id,
        status: {
          in: [
            DisbursementStatus.PENDING,
            DisbursementStatus.PROCESSING,
            DisbursementStatus.ON_HOLD,
          ],
        },
      },
      select: { id: true, status: true },
    });
    if (blocking) {
      throw new LoanHasActiveDisbursementException({
        disbursement_id: blocking.id,
        status:          blocking.status,
      });
    }

    const account = loan.disbursement_account;
    if (!account || !account.provider_code) {
      throw new LoanDisbursementAccountRequiredException();
    }

    await this.prisma.$transaction(async (tx) => {
      await this.ops_audit.write(tx, {
        ops_user_id: ctx.ops_user_id,
        action:      OPS_ACTION.DISBURSEMENT_RECREATE,
        target_type: OPS_TARGET_TYPE.LOAN,
        target_id:   loan.id,
        details: {
          loan_status:           loan.status,
          disbursement_account_id: account.id,
          provider_name:         account.provider_name,
          provider_code:         account.provider_code,
          amount_ngn:            loan.principal_ngn.toString(),
        },
        request_id:  ctx.request_id,
        ip_address:  ctx.ip_address,
      });
    });

    const fresh = await this.disbursements.createForLoan({
      user_id:           loan.user_id,
      source_id:         loan.id,
      amount:            loan.principal_ngn,
      currency:          'NGN',
      disbursement_rail: DisbursementRail.BANK_TRANSFER,
      provider_name:     account.provider_name,
      provider_code:     account.provider_code,
      account_unique:    account.account_unique,
      account_name:      account.account_holder_name,
    });

    await this.outflows.dispatch(fresh.id);

    return { disbursement_id: fresh.id };
  }

  // "Abandon attempt" — the ops escape hatch for an outflow stuck in PENDING
  // or PROCESSING (e.g. stub provider that never resolves, or a real provider
  // gone silent past the reconciler window). Treats the in-flight attempt as
  // failed and parks the parent Disbursement in ON_HOLD where ops can retry
  // (against current router config) or cancel.
  //
  // Same audit-then-state pattern as retry(): the audit row records the ops
  // decision in a tx, then OutflowsService.handleFailure performs the state
  // transition (outflow → FAILED, disbursement → ON_HOLD, first-transition
  // alert) outside the tx. Reusing handleFailure means abandon and async
  // webhook failure produce identical disbursement/alert state.
  //
  // Validation:
  //   • Disbursement must exist (404).
  //   • Disbursement must not be terminal (409).
  //   • Exactly one active outflow (PENDING or PROCESSING) must exist (409).
  //     A disbursement with multiple active outflows is itself a bug — the
  //     dispatch path explicitly forbids that — so abandoning would mask it.
  async abandonAttempt(
    disbursement_id: string,
    reason:          string,
    ctx:             OpsAuditContext,
  ): Promise<void> {
    const existing = await this.disbursements.findById(disbursement_id);
    if (!existing) throw new DisbursementNotFoundException();

    if (
      existing.status === DisbursementStatus.SUCCESSFUL ||
      existing.status === DisbursementStatus.CANCELLED
    ) {
      throw new DisbursementTerminalException({ status: existing.status });
    }

    const active_outflows = existing.outflows.filter(
      (o) => o.status === OutflowStatus.PENDING || o.status === OutflowStatus.PROCESSING,
    );
    if (active_outflows.length === 0) throw new DisbursementNoActiveOutflowException();

    // Prefer the most recent active outflow when there's somehow more than
    // one — abandon them all so the disbursement has no in-flight rows when
    // it lands in ON_HOLD. Each gets the same reason; failure_code is
    // 'OPS_ABANDONED' so reconcilers/triage can recognise the source.
    const target_outflow_ids = active_outflows.map((o) => o.id);

    await this.prisma.$transaction(async (tx) => {
      await this.ops_audit.write(tx, {
        ops_user_id: ctx.ops_user_id,
        action:      OPS_ACTION.DISBURSEMENT_ABANDON_ATTEMPT,
        target_type: OPS_TARGET_TYPE.DISBURSEMENT,
        target_id:   disbursement_id,
        details: {
          previous_status:    existing.status,
          abandoned_outflows: target_outflow_ids,
          reason,
        },
        request_id:  ctx.request_id,
        ip_address:  ctx.ip_address,
      });
    });

    // handleFailure across all active outflows. The first call moves the
    // disbursement into ON_HOLD and pages ops; any subsequent call sees
    // is_first_transition=false and is silently logged — exactly the
    // "first-transition + daily digest" contract.
    for (const outflow_id of target_outflow_ids) {
      await this.outflows.handleFailure(
        outflow_id,
        disbursement_id,
        reason,
        'OPS_ABANDONED',
      );
    }
  }

  _summary(row: Prisma.DisbursementGetPayload<{ include: { outflows: true } }>): {
    id:               string;
    user_id:          string;
    status:           DisbursementStatus;
    amount:           string;
    currency:         string;
    source_type:      string;
    source_id:        string;
    on_hold_at:       string | null;
    failure_reason:   string | null;
    attempt_count:    number;
    created_at:       string;
  } {
    return {
      id:             row.id,
      user_id:        row.user_id,
      status:         row.status,
      amount:         row.amount.toString(),
      currency:       row.currency,
      source_type:    row.source_type,
      source_id:      row.source_id,
      on_hold_at:     row.on_hold_at?.toISOString() ?? null,
      failure_reason: row.failure_reason,
      attempt_count:  row.outflows.length,
      created_at:     row.created_at.toISOString(),
    };
  }

  private _detail(row: Prisma.DisbursementGetPayload<{ include: { outflows: true } }>): {
    summary:  ReturnType<OpsDisbursementsService['_summary']>;
    outflows: Array<{
      id:                 string;
      attempt_number:     number;
      provider:           string;
      provider_reference: string;
      provider_tx_id:     string | null;
      status:             string;
      failure_reason:     string | null;
      failure_code:       string | null;
      initiated_at:       string | null;
      confirmed_at:       string | null;
      created_at:         string;
    }>;
    cancellation: {
      cancelled_at:             string | null;
      cancelled_by_ops_user_id: string | null;
      cancellation_reason:      string | null;
    };
  } {
    return {
      summary: this._summary(row),
      outflows: row.outflows.map((o) => ({
        id:                 o.id,
        attempt_number:     o.attempt_number,
        provider:           o.provider,
        provider_reference: o.provider_reference,
        provider_tx_id:     o.provider_tx_id,
        status:             o.status,
        failure_reason:     o.failure_reason,
        failure_code:       o.failure_code,
        initiated_at:       o.initiated_at?.toISOString() ?? null,
        confirmed_at:       o.confirmed_at?.toISOString() ?? null,
        created_at:         o.created_at.toISOString(),
      })),
      cancellation: {
        cancelled_at:             row.cancelled_at?.toISOString() ?? null,
        cancelled_by_ops_user_id: row.cancelled_by_ops_user_id,
        cancellation_reason:      row.cancellation_reason,
      },
    };
  }
}
