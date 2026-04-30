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
import Decimal from 'decimal.js';
import { DisbursementRail, PaymentNetwork } from '@prisma/client';
import { BlinkProvider } from '@/providers/blink/blink.provider';
import {
  BlinkWebhookPayloadSchema,
  type BlinkWebhookHeaders,
} from '@/providers/blink/blink.types';
import { InflowsService } from '@/modules/inflows/inflows.service';
import { LoansService } from '@/modules/loans/loans.service';
import { DisbursementsService } from '@/modules/disbursements/disbursements.service';
import { OutflowsService } from '@/modules/disbursements/outflows.service';
import {
  WebhooksLogService,
  WebhookOutcome,
  type WebhookOutcomeValue,
} from '@/modules/webhooks-log/webhooks-log.service';

interface HandlerOutcome {
  outcome:             WebhookOutcomeValue;
  outcome_detail?:     string;
  external_reference?: string;
}

// Map Blink eventType prefixes to PaymentNetwork enum values.
const EVENT_TYPE_TO_NETWORK: Record<string, PaymentNetwork> = {
  'receive.lightning':    PaymentNetwork.LIGHTNING,
  'receive.onchain':      PaymentNetwork.BTC_ONCHAIN,
  'receive.intraledger':  PaymentNetwork.LIGHTNING,  // Blink intraledger is Lightning-native
};

@ApiTags('webhooks')
@Controller('webhooks/blink')
export class BlinkWebhookController {
  private readonly logger = new Logger(BlinkWebhookController.name);

  constructor(
    private readonly provider:      BlinkProvider,
    private readonly inflows:       InflowsService,
    private readonly loans:         LoansService,
    private readonly disbursements: DisbursementsService,
    private readonly outflows:      OutflowsService,
    private readonly webhooks_log:  WebhooksLogService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Inbound Blink webhook (Lightning / onchain receive events)' })
  @ApiResponse({ status: 200, description: 'Webhook processed' })
  @ApiResponse({ status: 401, description: 'Invalid signature' })
  async handle(
    @RawBody() raw_body: Buffer,
    @Headers() all_headers: Record<string, string | string[] | undefined>,
    @Headers('svix-id')        svix_id: string | undefined,
    @Headers('svix-timestamp') svix_timestamp: string | undefined,
    @Headers('svix-signature') svix_signature: string | undefined,
  ): Promise<{ received: true }> {
    const raw_str = raw_body.toString('utf8');

    // Phase 1 — record at entry so the row exists even if the handler throws.
    const log_id = await this.webhooks_log.record({
      provider:    'blink',
      http_method: 'POST',
      http_path:   '/v1/webhooks/blink',
      headers:     all_headers,
      raw_body:    raw_str,
    });

    const headers: BlinkWebhookHeaders = {
      'svix-id':        svix_id        ?? '',
      'svix-timestamp': svix_timestamp ?? '',
      'svix-signature': svix_signature ?? '',
    };

    if (!this.provider.verifyWebhookSignature(raw_str, JSON.stringify(headers))) {
      this.logger.warn({ svix_id }, 'Blink webhook signature mismatch — rejected');
      await this.webhooks_log.updateOutcome(log_id, {
        outcome:         WebhookOutcome.SIGNATURE_INVALID,
        signature_valid: false,
      });
      throw new UnauthorizedException('Invalid webhook signature');
    }

    let outcome: HandlerOutcome;
    try {
      outcome = await this._processVerified(raw_str);
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

    return { received: true };
  }

  private async _processVerified(raw_str: string): Promise<HandlerOutcome> {
    const result = BlinkWebhookPayloadSchema.safeParse(JSON.parse(raw_str));
    if (!result.success) {
      this.logger.warn({ errors: result.error.issues }, 'Blink webhook payload failed schema validation');
      return { outcome: WebhookOutcome.MALFORMED, outcome_detail: 'payload schema validation failed' };
    }

    const payload = result.data;

    // Reject events that don't belong to our configured Blink account.
    if (!this.provider.isOwnAccount(payload.accountId)) {
      this.logger.warn({ account_id: payload.accountId }, 'Blink webhook accountId mismatch — ignoring');
      return { outcome: WebhookOutcome.IGNORED, outcome_detail: 'accountId mismatch' };
    }

    // Only process receive events — ignore send/outbound events.
    if (!payload.eventType.startsWith('receive.')) {
      this.logger.log({ event_type: payload.eventType }, 'Blink webhook non-receive event — skipping');
      return { outcome: WebhookOutcome.IGNORED, outcome_detail: `non-receive event (${payload.eventType})` };
    }

    const payment_hash = payload.transaction.initiationVia.paymentHash
      ?? payload.transaction.initiationVia.txHash;

    if (!payment_hash) {
      this.logger.warn({ event_type: payload.eventType }, 'Blink webhook missing payment hash — skipping');
      return { outcome: WebhookOutcome.MALFORMED, outcome_detail: 'missing payment hash' };
    }

    const network = EVENT_TYPE_TO_NETWORK[payload.eventType] ?? PaymentNetwork.LIGHTNING;

    const { inflow, payment_request } = await this.inflows.ingest({
      asset:             'SAT',
      amount:            new Decimal(payload.transaction.settlementAmount),
      currency:          'SAT',
      network,
      receiving_address:  payment_hash,
      provider_reference: payment_hash,
      provider_response:  payload as unknown as Record<string, unknown>,
    });

    if (!payment_request) {
      this.logger.warn({ provider_reference: payment_hash, inflow_id: inflow.id }, 'Blink inflow unmatched — stored for ops review');
      return { outcome: WebhookOutcome.IGNORED, outcome_detail: 'inflow unmatched (no payment_request)', external_reference: payment_hash };
    }

    if (payment_request.source_type === 'LOAN') {
      await this._handleLoanCollateral(payment_request, inflow);
      return { outcome: WebhookOutcome.PROCESSED, outcome_detail: `loan ${payment_request.source_id} activated`, external_reference: payment_hash };
    }

    this.logger.log(
      { source_type: payment_request.source_type, source_id: payment_request.source_id },
      'Blink inflow matched — source type not yet handled, skipping post-match actions',
    );
    return { outcome: WebhookOutcome.IGNORED, outcome_detail: `source_type ${payment_request.source_type} not handled`, external_reference: payment_hash };
  }

  private async _handleLoanCollateral(
    payment_request: { source_id: string; user_id: string },
    inflow: { id: string; matched_at: Date | null },
  ): Promise<void> {
    const loan_id = payment_request.source_id;
    await this.loans.activateLoan(loan_id, inflow.matched_at ?? new Date());

    const loan = await this.loans.getLoan(payment_request.user_id, loan_id);

    // Net disbursement: customer receives principal − origination_fee. The
    // origination fee is collected as the spread between what we send out
    // and what they repay. Accrual + repayment waterfall stay on full
    // principal_ngn — origination is NOT a separate outstanding bucket.
    const disburse_amount = loan.principal_ngn.minus(loan.origination_fee_ngn);

    const disbursement = await this.disbursements.createForLoan({
      user_id:           loan.user_id,
      source_id:         loan.id,
      amount:            disburse_amount,
      currency:          'NGN',
      disbursement_rail: DisbursementRail.BANK_TRANSFER,
      provider_name:     (loan.disbursement_account as never as { provider_name: string }).provider_name,
      provider_code:     (loan.disbursement_account as never as { provider_code: string }).provider_code,
      account_unique:    (loan.disbursement_account as never as { account_unique: string }).account_unique,
      account_name:      (loan.disbursement_account as never as { account_holder_name: string | null }).account_holder_name,
    });

    await this.outflows.dispatch(disbursement.id);

    this.logger.log({ loan_id, disbursement_id: disbursement.id }, 'Loan activated and disbursement dispatched');

    // Repayment accounts are NOT provisioned here. PalmPay's dedicated
    // virtual-account endpoint issues permanent accounts, which don't match
    // the per-attempt repayment flow we want. Instead, a future
    // POST /v1/loans/:id/pay endpoint will call PalmPay's "pay with transfer"
    // (dynamic VA, ~2h TTL) or checkout-link API on demand when the customer
    // elects to repay.
  }
}
