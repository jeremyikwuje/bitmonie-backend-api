import { Injectable, Logger } from '@nestjs/common';
import { DisbursementStatus, OutflowStatus } from '@prisma/client';
import { PrismaService } from '@/database/prisma.service';
import { OpsAlertsService } from '@/modules/ops-alerts/ops-alerts.service';
import {
  DisbursementNotFoundException,
  DisbursementNotOnHoldException,
} from '@/common/errors/bitmonie.errors';
import { DisbursementsService } from './disbursements.service';
import { DisbursementRouter } from './disbursement-router.service';

@Injectable()
export class OutflowsService {
  private readonly logger = new Logger(OutflowsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly disbursements: DisbursementsService,
    private readonly router: DisbursementRouter,
    private readonly ops_alerts: OpsAlertsService,
  ) {}

  async dispatch(disbursement_id: string): Promise<void> {
    const disbursement = await this.disbursements.findById(disbursement_id);
    if (!disbursement) throw new DisbursementNotFoundException();

    // Idempotency: skip if already terminal or has an active outflow.
    // SUCCESSFUL and CANCELLED are both terminal — never re-attempt either.
    if (
      disbursement.status === DisbursementStatus.SUCCESSFUL ||
      disbursement.status === DisbursementStatus.CANCELLED
    ) return;

    const has_active = disbursement.outflows.some(
      (o) => o.status === OutflowStatus.PROCESSING || o.status === OutflowStatus.PENDING,
    );
    if (has_active) return;

    const attempt_number = disbursement.outflows.length + 1;
    await this._executeDispatch(disbursement, attempt_number);
  }

  // Ops-only: only an on-hold disbursement can be retried, and a retry creates
  // a NEW Outflow with attempt_number + 1 (per CLAUDE.md §5.6 — failed outflows
  // are immutable). No automatic retry: only this entry point dispatches a new
  // attempt against an on-hold disbursement.
  async retryDispatch(disbursement_id: string): Promise<void> {
    const disbursement = await this.disbursements.findById(disbursement_id);
    if (!disbursement) throw new DisbursementNotFoundException();

    if (disbursement.status !== DisbursementStatus.ON_HOLD) {
      throw new DisbursementNotOnHoldException({ status: disbursement.status });
    }

    const attempt_number = disbursement.outflows.length + 1;
    await this._executeDispatch(disbursement, attempt_number);
  }

  async handleSuccess(
    outflow_id: string,
    disbursement_id: string,
    provider_tx_id: string,
    provider_response: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.outflow.update({
      where: { id: outflow_id },
      data: {
        status:            OutflowStatus.SUCCESSFUL,
        provider_tx_id,
        provider_response: provider_response as never,
        confirmed_at:      new Date(),
      },
    });
    await this.disbursements.markSuccessful(disbursement_id);
  }

  // Async-failure path (provider webhook reports a previously-PROCESSING
  // outflow ultimately failed). Same semantics as the sync catch in
  // _executeDispatch: outflow → FAILED, parent disbursement → ON_HOLD,
  // first-transition alert.
  async handleFailure(
    outflow_id: string,
    disbursement_id: string,
    failure_reason: string,
    failure_code?: string,
  ): Promise<void> {
    await this.prisma.outflow.update({
      where: { id: outflow_id },
      data: {
        status: OutflowStatus.FAILED,
        failure_reason,
        failure_code,
      },
    });
    await this._markOnHoldAndMaybeAlert(
      disbursement_id,
      outflow_id,
      failure_reason,
      failure_code,
    );
  }

  private async _executeDispatch(
    disbursement: NonNullable<Awaited<ReturnType<DisbursementsService['findById']>>>,
    attempt_number: number,
  ): Promise<void> {
    const provider_reference = `${disbursement.id}:outflow:${attempt_number}`;
    const provider_name_value = this._resolveProviderName(disbursement.disbursement_rail);

    const outflow = await this.prisma.outflow.create({
      data: {
        disbursement_id:    disbursement.id,
        user_id:            disbursement.user_id,
        attempt_number,
        provider:           provider_name_value,
        provider_reference,
        status:             OutflowStatus.PENDING,
      },
    });

    // markProcessing also clears any prior on_hold_at / on_hold_alerted_at —
    // a retry is a fresh attempt; the next failure should re-page ops.
    await this.disbursements.markProcessing(disbursement.id);

    const provider = this.router.forRoute(disbursement.currency, disbursement.disbursement_rail);

    try {
      const { provider_txn_id, provider_response } = await provider.initiateTransfer({
        amount:         disbursement.amount,
        currency:       disbursement.currency,
        provider_name:  disbursement.provider_name,
        account_unique: disbursement.account_unique,
        account_name:   disbursement.account_name,
        reference:      provider_reference,
        narration:      `Loan disbursement ${disbursement.source_id}`,
      });

      await this.prisma.outflow.update({
        where: { id: outflow.id },
        data: {
          provider_tx_id:    provider_txn_id,
          provider_response: provider_response as never,
          status:            OutflowStatus.PROCESSING,
          initiated_at:      new Date(),
        },
      });
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(
        { disbursement_id: disbursement.id, attempt_number, reason },
        'Outflow initiation failed — moving disbursement to ON_HOLD',
      );

      await this.prisma.outflow.update({
        where: { id: outflow.id },
        data: { status: OutflowStatus.FAILED, failure_reason: reason },
      });

      await this._markOnHoldAndMaybeAlert(disbursement.id, outflow.id, reason);
    }
  }

  // Shared between the sync catch (provider throw) and async webhook failure.
  // markOnHold returns is_first_transition; alert + alerted_at marker fire
  // only when true. Repeat failures on the same disbursement (e.g. retry that
  // also fails) flow through the daily digest, not a fresh page.
  private async _markOnHoldAndMaybeAlert(
    disbursement_id: string,
    outflow_id:      string,
    failure_reason:  string,
    failure_code?:   string,
  ): Promise<void> {
    const { is_first_transition } = await this.disbursements.markOnHold(
      disbursement_id,
      failure_reason,
    );

    if (!is_first_transition) {
      this.logger.warn(
        { disbursement_id, outflow_id, failure_reason },
        'Disbursement was already ON_HOLD — alert suppressed; daily digest will surface it',
      );
      return;
    }

    // Re-fetch to build the alert payload (we need user_id, source, amount,
    // destination, attempt_number). findById is the canonical loader and
    // includes outflows so we can derive attempt_number from the row count.
    const fresh = await this.disbursements.findById(disbursement_id);
    if (!fresh) return;

    const this_outflow = fresh.outflows.find((o) => o.id === outflow_id);
    const attempt_number = this_outflow?.attempt_number ?? fresh.outflows.length;

    await this.ops_alerts.alertDisbursementOnHold({
      disbursement_id: fresh.id,
      user_id:         fresh.user_id,
      source_type:     fresh.source_type,
      source_id:       fresh.source_id,
      amount:          fresh.amount.toString(),
      currency:        fresh.currency,
      provider_name:   fresh.provider_name,
      account_unique:  fresh.account_unique,
      account_name:    fresh.account_name,
      attempt_number,
      failure_reason,
      failure_code,
    });

    await this.disbursements.markOnHoldAlerted(disbursement_id);
  }

  private _resolveProviderName(rail: string): string {
    // Derives a stable provider name string from the route config at runtime.
    // The value is data (stored in outflow.provider), not a column name.
    const router_any = this.router as unknown as { routes: { NGN?: Record<string, { provider: string }> } };
    return router_any.routes?.NGN?.[rail]?.provider ?? 'unknown';
  }
}
