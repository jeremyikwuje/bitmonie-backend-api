import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  RawBody,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { LoanStatus, OutflowStatus, PaymentNetwork } from '@prisma/client';
import Decimal from 'decimal.js';
import { PalmpayProvider } from '@/providers/palmpay/palmpay.provider';
import {
  PalmpayPayoutNotificationSchema,
  PalmpayCollectionNotificationSchema,
  PALMPAY_ORDER_STATUS_SUCCESS,
  type PalmpayCollectionNotification,
} from '@/providers/palmpay/palmpay.types';
import { OutflowsService } from '@/modules/disbursements/outflows.service';
import { LoansService } from '@/modules/loans/loans.service';
import { OpsAlertsService } from '@/modules/ops-alerts/ops-alerts.service';
import {
  WebhooksLogService,
  WebhookOutcome,
  type WebhookOutcomeValue,
} from '@/modules/webhooks-log/webhooks-log.service';
import { PrismaService } from '@/database/prisma.service';
import { MIN_PARTIAL_REPAYMENT_NGN } from '@/common/constants';

interface HandlerOutcome {
  outcome:             WebhookOutcomeValue;
  outcome_detail?:     string;
  external_reference?: string;
}

// Our provider_reference format for outflow attempts is "outflow-{n}-{disbursement_id}".
// The "outflow-" prefix discriminates payout notifications from collection notifications.
// The legacy "{uuid}:outflow:{n}" form is also matched so in-flight rows from before the
// rename still route correctly when PalmPay's late webhook arrives — once all
// pre-rename outflows are terminal this branch can be dropped.
const OUTFLOW_REFERENCE_PATTERN = /^outflow-\d+-|:outflow:\d+$/;

// PalmPay requires plain-text "success" as the acknowledgement body for all webhook types.
const PALMPAY_ACK = 'success';

// Reasons that get stored on unmatched Inflow rows so ops can triage.
type UnmatchedReason =
  | 'no_user_for_va'
  | 'below_floor'
  | 'no_active_loans'
  | 'multiple_active_loans'
  | 'credit_failed';

@ApiTags('webhooks')
@Controller('webhooks/palmpay')
export class PalmpayWebhookController {
  private readonly logger = new Logger(PalmpayWebhookController.name);

  constructor(
    private readonly provider:      PalmpayProvider,
    private readonly outflows:      OutflowsService,
    private readonly loans:         LoansService,
    private readonly prisma:        PrismaService,
    private readonly ops_alerts:    OpsAlertsService,
    private readonly webhooks_log:  WebhooksLogService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Inbound PalmPay webhook (payout status updates and collection notifications)' })
  @ApiResponse({ status: 200, description: 'Webhook acknowledged — responds with plain text "success"' })
  @ApiResponse({ status: 401, description: 'Invalid signature' })
  async handle(
    @RawBody() raw_body: Buffer,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<string> {
    const raw_str = raw_body.toString('utf8');

    // Phase 1 — record at entry BEFORE signature verification so the row
    // exists even if the handler throws mid-flight. record() is best-effort:
    // a DB failure returns an empty id, and updateOutcome() no-ops on empty.
    const log_id = await this.webhooks_log.record({
      provider:    'palmpay',
      http_method: 'POST',
      http_path:   '/v1/webhooks/palmpay',
      headers,
      raw_body:    raw_str,
    });

    this.logger.log(
      { body_length: raw_body.length, body_preview: raw_str.slice(0, 500) },
      'PalmPay webhook received',
    );

    // PalmPay signs the full payload body — signature is embedded in the `sign` field
    if (!this.provider.verifyWebhookSignature(raw_str, '')) {
      this.logger.warn(
        { body_preview: raw_str.slice(0, 500) },
        'PalmPay webhook signature mismatch — rejected',
      );
      await this.webhooks_log.updateOutcome(log_id, {
        outcome:         WebhookOutcome.SIGNATURE_INVALID,
        signature_valid: false,
      });
      throw new UnauthorizedException('Invalid webhook signature');
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw_str) as Record<string, unknown>;
    } catch {
      this.logger.warn('PalmPay webhook body is not valid JSON');
      await this.webhooks_log.updateOutcome(log_id, {
        outcome:         WebhookOutcome.MALFORMED,
        outcome_detail:  'Body is not valid JSON',
        signature_valid: true,
      });
      return PALMPAY_ACK;
    }

    // Route by orderId shape: outflow references follow "outflow-{n}-{disbursement_id}".
    // Collection (payin) notifications have no orderId field at all.
    const order_id = typeof parsed['orderId'] === 'string' ? parsed['orderId'] : '';

    let outcome: HandlerOutcome;
    try {
      outcome = OUTFLOW_REFERENCE_PATTERN.test(order_id)
        ? await this._handlePayoutNotification(parsed)
        : await this._handleCollectionNotification(parsed);
    } catch (err) {
      // Handler threw — log so the row doesn't stay in RECEIVED, then rethrow
      // to preserve the existing error path (NestJS will 500 / log unhandled).
      const detail = err instanceof Error ? err.message : String(err);
      await this.webhooks_log.updateOutcome(log_id, {
        outcome:         WebhookOutcome.ERROR,
        outcome_detail:  detail.slice(0, 1000),
        signature_valid: true,
      });
      throw err;
    }

    await this.webhooks_log.updateOutcome(log_id, {
      outcome:            outcome.outcome,
      outcome_detail:     outcome.outcome_detail,
      external_reference: outcome.external_reference,
      signature_valid:    true,
    });

    return PALMPAY_ACK;
  }

  // ── Payout notification (outbound transfer status update) ──────────────────

  private async _handlePayoutNotification(parsed: Record<string, unknown>): Promise<HandlerOutcome> {
    const result = PalmpayPayoutNotificationSchema.safeParse(parsed);
    if (!result.success) {
      this.logger.warn({ errors: result.error.issues }, 'PalmPay payout notification failed schema validation');
      return { outcome: WebhookOutcome.MALFORMED, outcome_detail: 'payout schema validation failed' };
    }

    const payload = result.data;
    const provider_reference = payload.orderId;

    const outflow = await this.prisma.outflow.findUnique({ where: { provider_reference } });

    if (!outflow) {
      this.logger.warn({ provider_reference }, 'PalmPay payout webhook: outflow not found — ignoring');
      return { outcome: WebhookOutcome.IGNORED, outcome_detail: 'outflow not found', external_reference: provider_reference };
    }

    // Idempotency guard — already terminal
    if (outflow.status === OutflowStatus.SUCCESSFUL || outflow.status === OutflowStatus.FAILED) {
      this.logger.log({ provider_reference, status: outflow.status }, 'PalmPay payout webhook: already terminal — skipping');
      return { outcome: WebhookOutcome.IGNORED, outcome_detail: `outflow already terminal (${outflow.status})`, external_reference: provider_reference };
    }

    // Independently verify the payout status by querying PalmPay directly.
    // We never act on the webhook claim alone — the API response is authoritative.
    let verified_status: Awaited<ReturnType<typeof this.provider.getTransferStatus>>;
    try {
      verified_status = await this.provider.getTransferStatus(provider_reference);
    } catch (err) {
      this.logger.error(
        { provider_reference, error: err instanceof Error ? err.message : String(err) },
        'PalmPay payout webhook: status query failed — deferring to next retry',
      );
      return { outcome: WebhookOutcome.DEFERRED, outcome_detail: 'status query failed', external_reference: provider_reference };
    }

    if (verified_status.status === 'successful') {
      await this.outflows.handleSuccess(
        outflow.id,
        outflow.disbursement_id,
        payload.orderNo ?? provider_reference,
        parsed,
      );
      this.logger.log({ provider_reference }, 'Disbursement confirmed successful via status query');
      return { outcome: WebhookOutcome.PROCESSED, outcome_detail: 'outflow → SUCCESSFUL', external_reference: provider_reference };
    }

    if (verified_status.status === 'failed') {
      await this.outflows.handleFailure(
        outflow.id,
        outflow.disbursement_id,
        verified_status.failure_reason ?? payload.message ?? 'Provider reported failure',
        verified_status.failure_code ?? String(payload.orderStatus),
      );
      this.logger.warn({ provider_reference }, 'Disbursement failed (confirmed via status query)');
      return { outcome: WebhookOutcome.PROCESSED, outcome_detail: 'outflow → FAILED', external_reference: provider_reference };
    }

    // Status query says still processing — webhook was premature or out-of-order.
    // PalmPay will retry; we'll process on the next delivery once it resolves.
    this.logger.log(
      { provider_reference, webhook_status: payload.orderStatus },
      'PalmPay payout webhook: status query returned processing — deferring',
    );
    return { outcome: WebhookOutcome.DEFERRED, outcome_detail: 'status query says still processing', external_reference: provider_reference };
  }

  // ── Collection notification (inbound virtual account payment) ──────────────
  // v1.1 matching flow (see docs/repayment-matching-redesign.md §5.1):
  //   1. Resolve user from virtualAccountNo via UserRepaymentAccount.
  //   2. Floor check: amount < N10,000 → unmatched, alert ops.
  //   3. Find user's ACTIVE loans.
  //        Zero  → unmatched, alert ops.
  //        Multi → unmatched, claim path (POST /v1/loans/:id/claim-inflow).
  //        Exactly one → auto-credit via creditInflow(match_method='AUTO_AMOUNT').
  //   No narration parsing (PalmPay doesn't forward it). No amount-equals-total
  //   matching (waterfall handles partial / full / overpay).

  private async _handleCollectionNotification(parsed: Record<string, unknown>): Promise<HandlerOutcome> {
    const result = PalmpayCollectionNotificationSchema.safeParse(parsed);
    if (!result.success) {
      this.logger.warn({ errors: result.error.issues }, 'PalmPay collection notification failed schema validation');
      return { outcome: WebhookOutcome.MALFORMED, outcome_detail: 'collection schema validation failed' };
    }

    const payload = result.data;
    const ext_ref = payload.orderNo;

    if (payload.orderStatus !== PALMPAY_ORDER_STATUS_SUCCESS) {
      this.logger.log(
        { order_no: payload.orderNo, order_status: payload.orderStatus },
        'PalmPay collection: non-success status — skipping',
      );
      return { outcome: WebhookOutcome.IGNORED, outcome_detail: `collection orderStatus=${payload.orderStatus}`, external_reference: ext_ref };
    }

    if (!payload.virtualAccountNo) {
      this.logger.warn({ order_no: payload.orderNo }, 'PalmPay collection: missing virtualAccountNo');
      return { outcome: WebhookOutcome.MALFORMED, outcome_detail: 'missing virtualAccountNo', external_reference: ext_ref };
    }

    const amount_ngn = new Decimal(payload.orderAmount).div(100);

    // 1. Resolve user from VA number.
    const repayment_account = await this.prisma.userRepaymentAccount.findUnique({
      where: { virtual_account_no: payload.virtualAccountNo },
    });
    if (!repayment_account) {
      await this._storeUnmatchedInflow(payload, parsed, amount_ngn, null, 'no_user_for_va');
      return { outcome: WebhookOutcome.IGNORED, outcome_detail: 'no_user_for_va', external_reference: ext_ref };
    }

    const user_id = repayment_account.user_id;

    // 2. Floor check.
    if (amount_ngn.lt(MIN_PARTIAL_REPAYMENT_NGN)) {
      await this._storeUnmatchedInflow(payload, parsed, amount_ngn, user_id, 'below_floor');
      return { outcome: WebhookOutcome.IGNORED, outcome_detail: 'below_floor', external_reference: ext_ref };
    }

    // 3. Find ACTIVE loans for this user.
    const active_loans = await this.prisma.loan.findMany({
      where:  { user_id, status: LoanStatus.ACTIVE },
      select: { id: true },
    });

    if (active_loans.length === 0) {
      await this._storeUnmatchedInflow(payload, parsed, amount_ngn, user_id, 'no_active_loans');
      return { outcome: WebhookOutcome.IGNORED, outcome_detail: 'no_active_loans', external_reference: ext_ref };
    }

    if (active_loans.length > 1) {
      // Customer has multiple ACTIVE loans — webhook can't safely guess. Inflow
      // sits unmatched; customer disambiguates via POST /v1/loans/:id/claim-inflow.
      await this._storeUnmatchedInflow(payload, parsed, amount_ngn, user_id, 'multiple_active_loans');
      return { outcome: WebhookOutcome.IGNORED, outcome_detail: 'multiple_active_loans', external_reference: ext_ref };
    }

    // Exactly one active loan — auto-credit. We need the Inflow row to exist
    // first so creditInflow can mark it matched. Upsert is idempotent on
    // provider_reference @unique.
    const matched_loan = active_loans[0]!;
    let inflow;
    try {
      inflow = await this.prisma.inflow.upsert({
        where:  { provider_reference: payload.orderNo },
        create: {
          user_id,
          asset:              'NGN',
          amount:             amount_ngn,
          currency:           'NGN',
          network:            PaymentNetwork.BANK_TRANSFER,
          receiving_address:  payload.virtualAccountNo,
          provider_reference: payload.orderNo,
          is_matched:         false,
          provider_response:  parsed as never,
        },
        update: {},
      });
    } catch (err) {
      this.logger.error(
        { order_no: payload.orderNo, error: err instanceof Error ? err.message : String(err) },
        'PalmPay collection: failed to persist Inflow — caller will retry',
      );
      return { outcome: WebhookOutcome.ERROR, outcome_detail: 'inflow upsert failed', external_reference: ext_ref };
    }

    // If the inflow was already matched (PalmPay retry after first credit),
    // creditInflow's idempotency on REPAID handles the no-op gracefully — but
    // we can short-circuit here to skip the lock contention.
    if (inflow.is_matched) {
      this.logger.log(
        { loan_id: matched_loan.id, order_no: payload.orderNo },
        'PalmPay collection: inflow already matched — duplicate webhook, no-op',
      );
      return { outcome: WebhookOutcome.IGNORED, outcome_detail: 'inflow already matched (duplicate webhook)', external_reference: ext_ref };
    }

    try {
      const result = await this.loans.creditInflow({
        inflow_id:    inflow.id,
        loan_id:      matched_loan.id,
        amount_ngn,
        match_method: 'AUTO_AMOUNT',
      });
      this.logger.log(
        {
          loan_id:        matched_loan.id,
          order_no:       payload.orderNo,
          amount_ngn:     amount_ngn.toFixed(2),
          new_status:     result.new_status,
          outstanding:    result.outstanding_ngn,
          overpay_ngn:    result.overpay_ngn,
        },
        'PalmPay repayment auto-matched and credited',
      );
      return { outcome: WebhookOutcome.PROCESSED, outcome_detail: `loan ${matched_loan.id} → ${result.new_status}`, external_reference: ext_ref };
    } catch (err) {
      this.logger.error(
        {
          loan_id:    matched_loan.id,
          inflow_id:  inflow.id,
          order_no:   payload.orderNo,
          error:      err instanceof Error ? err.message : String(err),
        },
        'PalmPay collection: creditInflow failed — inflow remains unmatched, ops must investigate',
      );
      // Inflow row already exists with is_matched=false; ops can retry via the admin path.
      await this.ops_alerts.alertUnmatchedInflow({
        reason:          'credit_failed',
        provider:        'palmpay',
        order_no:        payload.orderNo,
        amount_ngn:      amount_ngn.toFixed(2),
        user_id,
        virtual_account: payload.virtualAccountNo,
        payer_name:      payload.payerAccountName,
        payer_account:   payload.payerAccountNo,
        loan_id:         matched_loan.id,
        detail:          err instanceof Error ? err.message : String(err),
      });
      return { outcome: WebhookOutcome.ERROR, outcome_detail: 'creditInflow failed', external_reference: ext_ref };
    }
  }

  // Insert (upsert) an Inflow row that the auto-match path could not credit and
  // page ops via OpsAlertsService. The reason is stored in
  // provider_response.bitmonie_unmatched_reason for triage. Idempotent on
  // provider_reference @unique — duplicate webhooks re-resolve to the same row.
  //
  // Whether the email actually goes out is decided by OpsAlertsService (it
  // skips silently when INTERNAL_ALERT_EMAIL is unset, which is normal in dev).
  // We always send the alert here — duplicate-paging concerns are bounded
  // because the upstream upsert already deduplicates by provider_reference.
  private async _storeUnmatchedInflow(
    payload: PalmpayCollectionNotification,
    raw: Record<string, unknown>,
    amount_ngn: Decimal,
    user_id: string | null,
    reason: UnmatchedReason,
  ): Promise<void> {
    try {
      await this.prisma.inflow.upsert({
        where:  { provider_reference: payload.orderNo },
        create: {
          user_id,
          asset:              'NGN',
          amount:             amount_ngn,
          currency:           'NGN',
          network:            PaymentNetwork.BANK_TRANSFER,
          receiving_address:  payload.virtualAccountNo ?? '',
          provider_reference: payload.orderNo,
          is_matched:         false,
          provider_response:  { ...raw, bitmonie_unmatched_reason: reason } as never,
        },
        update: {},
      });
    } catch (err) {
      this.logger.error(
        { order_no: payload.orderNo, reason, error: err instanceof Error ? err.message : String(err) },
        'PalmPay collection: failed to persist unmatched inflow record',
      );
    }

    this.logger.warn(
      {
        order_no:        payload.orderNo,
        amount_ngn:      amount_ngn.toFixed(2),
        user_id,
        virtual_account: payload.virtualAccountNo,
        reason,
      },
      'PalmPay collection: inflow could not be auto-matched — ops triage required',
    );

    await this.ops_alerts.alertUnmatchedInflow({
      reason,
      provider:        'palmpay',
      order_no:        payload.orderNo,
      amount_ngn:      amount_ngn.toFixed(2),
      user_id,
      virtual_account: payload.virtualAccountNo,
      payer_name:      payload.payerAccountName,
      payer_account:   payload.payerAccountNo,
    });
  }
}
