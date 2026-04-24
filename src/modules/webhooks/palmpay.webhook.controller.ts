import {
  Controller,
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
import { PrismaService } from '@/database/prisma.service';
import { MIN_PARTIAL_REPAYMENT_NGN } from '@/common/constants';

// Our provider_reference format for outflow attempts is "{disbursement_id}:outflow:{n}".
// The ":outflow:" infix is the discriminator between payout and collection notifications.
const OUTFLOW_REFERENCE_PATTERN = /:outflow:\d+$/;

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
    private readonly provider:   PalmpayProvider,
    private readonly outflows:   OutflowsService,
    private readonly loans:      LoansService,
    private readonly prisma:     PrismaService,
    private readonly ops_alerts: OpsAlertsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Inbound PalmPay webhook (payout status updates and collection notifications)' })
  @ApiResponse({ status: 200, description: 'Webhook acknowledged — responds with plain text "success"' })
  @ApiResponse({ status: 401, description: 'Invalid signature' })
  async handle(@RawBody() raw_body: Buffer): Promise<string> {
    const raw_str = raw_body.toString('utf8');

    // PalmPay signs the full payload body — signature is embedded in the `sign` field
    if (!this.provider.verifyWebhookSignature(raw_str, '')) {
      this.logger.warn('PalmPay webhook signature mismatch — rejected');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw_str) as Record<string, unknown>;
    } catch {
      this.logger.warn('PalmPay webhook body is not valid JSON');
      return PALMPAY_ACK;
    }

    // Route by orderId shape: outflow references follow "{disbursement_id}:outflow:{n}".
    // Collection (payin) notifications have no orderId field at all.
    const order_id = typeof parsed['orderId'] === 'string' ? parsed['orderId'] : '';

    if (OUTFLOW_REFERENCE_PATTERN.test(order_id)) {
      return this._handlePayoutNotification(parsed);
    }

    return this._handleCollectionNotification(parsed);
  }

  // ── Payout notification (outbound transfer status update) ──────────────────

  private async _handlePayoutNotification(parsed: Record<string, unknown>): Promise<string> {
    const result = PalmpayPayoutNotificationSchema.safeParse(parsed);
    if (!result.success) {
      this.logger.warn({ errors: result.error.issues }, 'PalmPay payout notification failed schema validation');
      return PALMPAY_ACK;
    }

    const payload = result.data;
    const provider_reference = payload.orderId;

    const outflow = await this.prisma.outflow.findUnique({ where: { provider_reference } });

    if (!outflow) {
      this.logger.warn({ provider_reference }, 'PalmPay payout webhook: outflow not found — ignoring');
      return PALMPAY_ACK;
    }

    // Idempotency guard — already terminal
    if (outflow.status === OutflowStatus.SUCCESSFUL || outflow.status === OutflowStatus.FAILED) {
      this.logger.log({ provider_reference, status: outflow.status }, 'PalmPay payout webhook: already terminal — skipping');
      return PALMPAY_ACK;
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
      return PALMPAY_ACK;
    }

    if (verified_status.status === 'successful') {
      await this.outflows.handleSuccess(
        outflow.id,
        outflow.disbursement_id,
        payload.orderNo ?? provider_reference,
        parsed,
      );
      this.logger.log({ provider_reference }, 'Disbursement confirmed successful via status query');
    } else if (verified_status.status === 'failed') {
      await this.outflows.handleFailure(
        outflow.id,
        outflow.disbursement_id,
        verified_status.failure_reason ?? payload.message ?? 'Provider reported failure',
        verified_status.failure_code ?? String(payload.orderStatus),
      );
      this.logger.warn({ provider_reference }, 'Disbursement failed (confirmed via status query)');
    } else {
      // Status query says still processing — webhook was premature or out-of-order.
      // PalmPay will retry; we'll process on the next delivery once it resolves.
      this.logger.log(
        { provider_reference, webhook_status: payload.orderStatus },
        'PalmPay payout webhook: status query returned processing — deferring',
      );
    }

    return PALMPAY_ACK;
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

  private async _handleCollectionNotification(parsed: Record<string, unknown>): Promise<string> {
    const result = PalmpayCollectionNotificationSchema.safeParse(parsed);
    if (!result.success) {
      this.logger.warn({ errors: result.error.issues }, 'PalmPay collection notification failed schema validation');
      return PALMPAY_ACK;
    }

    const payload = result.data;

    if (payload.orderStatus !== PALMPAY_ORDER_STATUS_SUCCESS) {
      this.logger.log(
        { order_no: payload.orderNo, order_status: payload.orderStatus },
        'PalmPay collection: non-success status — skipping',
      );
      return PALMPAY_ACK;
    }

    if (!payload.virtualAccountNo) {
      this.logger.warn({ order_no: payload.orderNo }, 'PalmPay collection: missing virtualAccountNo');
      return PALMPAY_ACK;
    }

    const amount_ngn = new Decimal(payload.orderAmount).div(100);

    // 1. Resolve user from VA number.
    const repayment_account = await this.prisma.userRepaymentAccount.findUnique({
      where: { virtual_account_no: payload.virtualAccountNo },
    });
    if (!repayment_account) {
      await this._storeUnmatchedInflow(payload, parsed, amount_ngn, null, 'no_user_for_va');
      return PALMPAY_ACK;
    }

    const user_id = repayment_account.user_id;

    // 2. Floor check.
    if (amount_ngn.lt(MIN_PARTIAL_REPAYMENT_NGN)) {
      await this._storeUnmatchedInflow(payload, parsed, amount_ngn, user_id, 'below_floor');
      return PALMPAY_ACK;
    }

    // 3. Find ACTIVE loans for this user.
    const active_loans = await this.prisma.loan.findMany({
      where:  { user_id, status: LoanStatus.ACTIVE },
      select: { id: true },
    });

    if (active_loans.length === 0) {
      await this._storeUnmatchedInflow(payload, parsed, amount_ngn, user_id, 'no_active_loans');
      return PALMPAY_ACK;
    }

    if (active_loans.length > 1) {
      // Customer has multiple ACTIVE loans — webhook can't safely guess. Inflow
      // sits unmatched; customer disambiguates via POST /v1/loans/:id/claim-inflow.
      await this._storeUnmatchedInflow(payload, parsed, amount_ngn, user_id, 'multiple_active_loans');
      return PALMPAY_ACK;
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
      return PALMPAY_ACK;
    }

    // If the inflow was already matched (PalmPay retry after first credit),
    // creditInflow's idempotency on REPAID handles the no-op gracefully — but
    // we can short-circuit here to skip the lock contention.
    if (inflow.is_matched) {
      this.logger.log(
        { loan_id: matched_loan.id, order_no: payload.orderNo },
        'PalmPay collection: inflow already matched — duplicate webhook, no-op',
      );
      return PALMPAY_ACK;
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
    }

    return PALMPAY_ACK;
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
