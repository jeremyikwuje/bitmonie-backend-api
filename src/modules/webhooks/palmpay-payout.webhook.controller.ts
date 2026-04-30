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
import { OutflowStatus } from '@prisma/client';
import { PalmpayProvider } from '@/providers/palmpay/palmpay.provider';
import {
  PalmpayPayoutNotificationSchema,
} from '@/providers/palmpay/palmpay.types';
import { OutflowsService } from '@/modules/disbursements/outflows.service';
import {
  WebhooksLogService,
  WebhookOutcome,
  type WebhookOutcomeValue,
} from '@/modules/webhooks-log/webhooks-log.service';
import { PrismaService } from '@/database/prisma.service';

interface HandlerOutcome {
  outcome:             WebhookOutcomeValue;
  outcome_detail?:     string;
  external_reference?: string;
}

// PalmPay requires plain-text "success" as the acknowledgement body for all webhook types.
const PALMPAY_ACK = 'success';

// Payout-only controller. Each PalmPay webhook role has its own URL so the
// merchant dashboard can target controllers individually and a misrouted
// payload becomes a 4xx instead of a silent drop:
//
//   /v1/webhooks/palmpay/payout               ← here (outbound transfer status)
//   /v1/webhooks/palmpay/collection/va        ← virtual-account payin (loan repayments)
//   /v1/webhooks/palmpay/collection/universal ← reserved for PalmPay Checkout (future)
@ApiTags('webhooks')
@Controller('webhooks/palmpay/payout')
export class PalmpayPayoutWebhookController {
  private readonly logger = new Logger(PalmpayPayoutWebhookController.name);

  constructor(
    private readonly provider:      PalmpayProvider,
    private readonly outflows:      OutflowsService,
    private readonly prisma:        PrismaService,
    private readonly webhooks_log:  WebhooksLogService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Inbound PalmPay payout (transfer) status notification' })
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
      http_path:   '/v1/webhooks/palmpay/payout',
      headers,
      raw_body:    raw_str,
    });

    this.logger.log(
      { body_length: raw_body.length, body_preview: raw_str.slice(0, 500) },
      'PalmPay payout webhook received',
    );

    // PalmPay signs the full payload body — signature is embedded in the `sign` field
    if (!this.provider.verifyWebhookSignature(raw_str, '')) {
      this.logger.warn(
        { body_preview: raw_str.slice(0, 500) },
        'PalmPay payout webhook signature mismatch — rejected',
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
      this.logger.warn('PalmPay payout webhook body is not valid JSON');
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

  // ── Payout notification (outbound transfer status update) ──────────────────

  private async _handle(parsed: Record<string, unknown>): Promise<HandlerOutcome> {
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
}
