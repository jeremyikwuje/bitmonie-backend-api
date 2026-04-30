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
import { LoanStatus, PaymentNetwork } from '@prisma/client';
import Decimal from 'decimal.js';
import { PalmpayProvider } from '@/providers/palmpay/palmpay.provider';
import {
  PalmpayCollectionNotificationSchema,
  PALMPAY_COLLECTION_STATUS_SUCCESS,
  type PalmpayCollectionNotification,
} from '@/providers/palmpay/palmpay.types';
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

// PalmPay requires plain-text "success" as the acknowledgement body for all webhook types.
const PALMPAY_ACK = 'success';

// Tolerance (in kobo) for re-query amount drift vs webhook amount. PalmPay's
// platform query and webhook amounts are populated from the same settled-funds
// row, so any difference is suspicious — block the credit and page ops.
const REQUERY_AMOUNT_TOLERANCE_KOBO = 0;

// Reasons that get stored on unmatched Inflow rows so ops can triage.
type UnmatchedReason =
  | 'no_user_for_va'
  | 'below_floor'
  | 'no_active_loans'
  | 'multiple_active_loans'
  | 'credit_failed'
  | 'requery_unconfirmed'
  | 'requery_mismatch';

// Virtual-account collection (payin) notifications from PalmPay. One leaf
// per payin product so the merchant dashboard targets each controller
// individually and a misrouted payload becomes a 4xx instead of a silent drop:
//
//   /v1/webhooks/palmpay/payout               ← outbound transfer status
//   /v1/webhooks/palmpay/collection/va        ← here (loan repayments via VA)
//   /v1/webhooks/palmpay/collection/universal ← reserved for PalmPay Checkout (future)
//
// Why a re-query before crediting: webhook signature proves the message
// originated with PalmPay, but on its own that is not sufficient — we always
// hit `getCollectionOrderStatus` so the platform's books are the
// authoritative source for "did funds actually settle on this VA with this
// amount". Same verify-before-act discipline used on the payout side
// (getTransferStatus).
@ApiTags('webhooks')
@Controller('webhooks/palmpay/collection/va')
export class PalmpayCollectionVaWebhookController {
  private readonly logger = new Logger(PalmpayCollectionVaWebhookController.name);

  constructor(
    private readonly provider:      PalmpayProvider,
    private readonly loans:         LoansService,
    private readonly prisma:        PrismaService,
    private readonly ops_alerts:    OpsAlertsService,
    private readonly webhooks_log:  WebhooksLogService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Inbound PalmPay virtual-account collection notification (loan repayments)' })
  @ApiResponse({ status: 200, description: 'Webhook acknowledged — responds with plain text "success"' })
  @ApiResponse({ status: 401, description: 'Invalid signature' })
  async handle(
    @RawBody() raw_body: Buffer,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<string> {
    const raw_str = raw_body.toString('utf8');

    const log_id = await this.webhooks_log.record({
      provider:    'palmpay',
      http_method: 'POST',
      http_path:   '/v1/webhooks/palmpay/collection/va',
      headers,
      raw_body:    raw_str,
    });

    this.logger.log(
      { body_length: raw_body.length, body_preview: raw_str.slice(0, 500) },
      'PalmPay collection webhook received',
    );

    if (!this.provider.verifyWebhookSignature(raw_str, '')) {
      this.logger.warn(
        { body_preview: raw_str.slice(0, 500) },
        'PalmPay collection webhook signature mismatch — rejected',
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
      this.logger.warn('PalmPay collection webhook body is not valid JSON');
      await this.webhooks_log.updateOutcome(log_id, {
        outcome:         WebhookOutcome.MALFORMED,
        outcome_detail:  'Body is not valid JSON',
        signature_valid: true,
      });
      return PALMPAY_ACK;
    }

    let outcome: HandlerOutcome;
    try {
      outcome = await this._handle(parsed);
    } catch (err) {
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

  // v1.1 matching flow (see docs/repayment-matching-redesign.md §5.1):
  //   1. Resolve user from virtualAccountNo via UserRepaymentAccount.
  //   2. Floor check: amount < MIN_PARTIAL_REPAYMENT_NGN → unmatched, alert ops.
  //   3. Find user's ACTIVE loans.
  //        Zero  → unmatched, alert ops.
  //        Multi → unmatched, claim path (POST /v1/loans/:id/claim-inflow).
  //        Exactly one → independently re-query PalmPay, then auto-credit via
  //                      creditInflow(match_method='AUTO_AMOUNT').
  //   No narration parsing (PalmPay doesn't forward it). No amount-equals-total
  //   matching (waterfall handles partial / full / overpay).

  private async _handle(parsed: Record<string, unknown>): Promise<HandlerOutcome> {
    const result = PalmpayCollectionNotificationSchema.safeParse(parsed);
    if (!result.success) {
      this.logger.warn({ errors: result.error.issues }, 'PalmPay collection notification failed schema validation');
      return { outcome: WebhookOutcome.MALFORMED, outcome_detail: 'collection schema validation failed' };
    }

    const payload = result.data;
    const ext_ref = payload.orderNo;

    // Collection orderStatus uses a different scheme to payouts:
    // 1 = Success, 2 = Failed. See palmpay.types.ts for the full divergence
    // explanation. Anything not matching SUCCESS gets persisted as an Inflow
    // row (so duplicates dedupe on provider_reference) and ops gets paged.
    if (payload.orderStatus !== PALMPAY_COLLECTION_STATUS_SUCCESS) {
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
      // Customer has multiple ACTIVE loans — webhook can't safely guess.
      // Inflow sits unmatched; customer disambiguates via
      // POST /v1/loans/:id/claim-inflow.
      await this._storeUnmatchedInflow(payload, parsed, amount_ngn, user_id, 'multiple_active_loans');
      return { outcome: WebhookOutcome.IGNORED, outcome_detail: 'multiple_active_loans', external_reference: ext_ref };
    }

    const matched_loan = active_loans[0]!;

    // Independently re-query PalmPay before crediting. Webhook signature proves
    // the message came from PalmPay; the re-query proves PalmPay's own books
    // confirm the funds settled with the amount + VA the webhook claims.
    let verified: Awaited<ReturnType<typeof this.provider.getCollectionOrderStatus>>;
    try {
      verified = await this.provider.getCollectionOrderStatus(payload.orderNo);
    } catch (err) {
      this.logger.error(
        { order_no: payload.orderNo, error: err instanceof Error ? err.message : String(err) },
        'PalmPay collection: status re-query threw — deferring to PalmPay retry',
      );
      // Don't persist an Inflow on a transient query failure — PalmPay will
      // re-deliver this webhook and we'll try again. Same shape as the payout
      // path's defer-on-throw.
      return { outcome: WebhookOutcome.DEFERRED, outcome_detail: 'requery threw', external_reference: ext_ref };
    }

    if (verified.status !== 'successful') {
      // Platform query did NOT confirm success. Either still settling (webhook
      // outran the books — defer for PalmPay's retry to clear) or definitively
      // failed (rare; treat as unmatched + page ops).
      if (verified.status === 'failed') {
        await this._storeUnmatchedInflow(payload, parsed, amount_ngn, user_id, 'requery_mismatch');
        return { outcome: WebhookOutcome.IGNORED, outcome_detail: `requery returned failed: ${verified.failure_reason ?? 'unknown'}`, external_reference: ext_ref };
      }
      this.logger.warn(
        { order_no: payload.orderNo, requery_status: verified.status, requery_reason: verified.failure_reason },
        'PalmPay collection: re-query did not confirm success — deferring',
      );
      return { outcome: WebhookOutcome.DEFERRED, outcome_detail: `requery_${verified.status}`, external_reference: ext_ref };
    }

    // Cross-check fields PalmPay returned in the query against the webhook
    // payload — any disagreement on amount or VA means the webhook can't be
    // trusted to credit the loan. Persist an Inflow so duplicates dedupe and
    // ops can investigate, but don't credit.
    const requery_kobo = verified.amount_kobo;
    if (requery_kobo == null || Math.abs(requery_kobo - payload.orderAmount) > REQUERY_AMOUNT_TOLERANCE_KOBO) {
      this.logger.warn(
        { order_no: payload.orderNo, webhook_amount_kobo: payload.orderAmount, requery_amount_kobo: requery_kobo },
        'PalmPay collection: re-query amount disagrees with webhook — refusing to credit',
      );
      await this._storeUnmatchedInflow(payload, parsed, amount_ngn, user_id, 'requery_mismatch');
      return { outcome: WebhookOutcome.IGNORED, outcome_detail: 'requery_amount_mismatch', external_reference: ext_ref };
    }

    if (verified.virtual_account_no && verified.virtual_account_no !== payload.virtualAccountNo) {
      this.logger.warn(
        { order_no: payload.orderNo, webhook_va: payload.virtualAccountNo, requery_va: verified.virtual_account_no },
        'PalmPay collection: re-query VA disagrees with webhook — refusing to credit',
      );
      await this._storeUnmatchedInflow(payload, parsed, amount_ngn, user_id, 'requery_mismatch');
      return { outcome: WebhookOutcome.IGNORED, outcome_detail: 'requery_va_mismatch', external_reference: ext_ref };
    }

    // Re-query confirms the funds — safe to persist + credit.
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

    // Idempotency on duplicate webhook delivery — Inflow already credited.
    if (inflow.is_matched) {
      this.logger.log(
        { loan_id: matched_loan.id, order_no: payload.orderNo },
        'PalmPay collection: inflow already matched — duplicate webhook, no-op',
      );
      return { outcome: WebhookOutcome.IGNORED, outcome_detail: 'inflow already matched (duplicate webhook)', external_reference: ext_ref };
    }

    try {
      const credit = await this.loans.creditInflow({
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
          new_status:     credit.new_status,
          outstanding:    credit.outstanding_ngn,
          overpay_ngn:    credit.overpay_ngn,
        },
        'PalmPay repayment auto-matched and credited',
      );
      return { outcome: WebhookOutcome.PROCESSED, outcome_detail: `loan ${matched_loan.id} → ${credit.new_status}`, external_reference: ext_ref };
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

  // Insert (upsert) an Inflow row that the auto-match path could not credit
  // and page ops. Reason persisted in provider_response.bitmonie_unmatched_reason
  // for triage. Idempotent on provider_reference @unique — duplicate webhooks
  // re-resolve to the same row.
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
