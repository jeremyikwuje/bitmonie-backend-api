import { Injectable, Logger } from '@nestjs/common';
import { DisbursementStatus, OutflowStatus } from '@prisma/client';
import { PrismaService } from '@/database/prisma.service';
import { DisbursementsService } from './disbursements.service';
import { DisbursementRouter } from './disbursement-router.service';

@Injectable()
export class OutflowsService {
  private readonly logger = new Logger(OutflowsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly disbursements: DisbursementsService,
    private readonly router: DisbursementRouter,
  ) {}

  async dispatch(disbursement_id: string): Promise<void> {
    const disbursement = await this.disbursements.findById(disbursement_id);
    if (!disbursement) throw new Error(`Disbursement ${disbursement_id} not found`);

    // Idempotency guard: skip if already terminal or has an active outflow
    if (disbursement.status === DisbursementStatus.SUCCESSFUL) return;
    const has_active = disbursement.outflows.some(
      (o) => o.status === OutflowStatus.PROCESSING || o.status === OutflowStatus.PENDING,
    );
    if (has_active) return;

    const attempt_number = disbursement.outflows.length + 1;
    await this._executeDispatch(disbursement, attempt_number);
  }

  async retryDispatch(disbursement_id: string): Promise<void> {
    const disbursement = await this.disbursements.findById(disbursement_id);
    if (!disbursement) throw new Error(`Disbursement ${disbursement_id} not found`);

    if (disbursement.status !== DisbursementStatus.FAILED) {
      throw new Error(
        `Cannot retry disbursement ${disbursement_id} — current status is ${disbursement.status}`,
      );
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
    await this.disbursements.markFailed(disbursement_id, failure_reason);
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
      this.logger.error({ disbursement_id: disbursement.id, attempt_number, reason }, 'Outflow initiation failed');

      await this.prisma.outflow.update({
        where: { id: outflow.id },
        data: { status: OutflowStatus.FAILED, failure_reason: reason },
      });
      await this.disbursements.markFailed(disbursement.id, reason);
    }
  }

  private _resolveProviderName(rail: string): string {
    // Derives a stable provider name string from the route config at runtime.
    // The value is data (stored in outflow.provider), not a column name.
    const router_any = this.router as unknown as { routes: { NGN?: Record<string, { provider: string }> } };
    return router_any.routes?.NGN?.[rail]?.provider ?? 'unknown';
  }
}
