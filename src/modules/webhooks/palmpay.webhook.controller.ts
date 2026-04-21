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
import { OutflowStatus } from '@prisma/client';
import { PalmpayProvider } from '@/providers/palmpay/palmpay.provider';
import {
  PalmpayPayoutNotificationSchema,
  PalmpayCollectionNotificationSchema,
  PALMPAY_ORDER_STATUS_SUCCESS,
  PALMPAY_ORDER_STATUS_FAILED,
} from '@/providers/palmpay/palmpay.types';
import { OutflowsService } from '@/modules/disbursements/outflows.service';
import { PrismaService } from '@/database/prisma.service';

// Our provider_reference format for outflow attempts is "{disbursement_id}:outflow:{n}".
// The ":outflow:" infix is the discriminator between payout and collection notifications.
const OUTFLOW_REFERENCE_PATTERN = /:outflow:\d+$/;

// PalmPay requires plain-text "success" as the acknowledgement body for all webhook types.
const PALMPAY_ACK = 'success';

@ApiTags('webhooks')
@Controller('webhooks/palmpay')
export class PalmpayWebhookController {
  private readonly logger = new Logger(PalmpayWebhookController.name);

  constructor(
    private readonly provider: PalmpayProvider,
    private readonly outflows: OutflowsService,
    private readonly prisma:   PrismaService,
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

  // ── Collection notification (inbound virtual account payment) ───────────────
  // Handles loan repayments and offramp deposits received via PalmPay virtual accounts.
  // orderAmount is in CENTS — divide by 100 to get NGN.
  // accountReference identifies the loan or offramp order the payment belongs to.

  private async _handleCollectionNotification(parsed: Record<string, unknown>): Promise<string> {
    const result = PalmpayCollectionNotificationSchema.safeParse(parsed);
    if (!result.success) {
      this.logger.warn({ errors: result.error.issues }, 'PalmPay collection notification failed schema validation');
      return PALMPAY_ACK;
    }

    const payload = result.data;

    // Repayment / offramp handling wired here when those modules are built.
    // accountReference links to the loan or offramp order.
    this.logger.log(
      {
        order_no:          payload.orderNo,
        account_reference: payload.accountReference,
        order_amount_ngn:  payload.orderAmount / 100,
        currency:          payload.currency,
        order_status:      payload.orderStatus,
        payer_bank:        payload.payerBankName,
      },
      'PalmPay collection notification received — repayment handler not yet wired',
    );

    return PALMPAY_ACK;
  }
}
