import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EMAIL_PROVIDER, type EmailProvider } from '@/modules/auth/email.provider.interface';
import type { AppConfig } from '@/config/app.config';

// Reasons accepted by alertUnmatchedInflow — must stay in sync with the
// UnmatchedReason union in palmpay.webhook.controller.ts. (Co-located by intent
// since these are the only producers + consumers.)
export type UnmatchedInflowReason =
  | 'no_user_for_va'
  | 'below_floor'
  | 'no_active_loans'
  | 'multiple_active_loans'
  | 'credit_failed';

export interface UnmatchedInflowAlertParams {
  reason:           UnmatchedInflowReason;
  provider:         string;          // 'palmpay'
  order_no:         string;
  amount_ngn:       string;
  user_id:          string | null;
  virtual_account:  string | undefined;
  payer_name?:      string;
  payer_account?:   string;
  loan_id?:         string;          // when reason='credit_failed'
  detail?:          string;          // free-form (error message, etc.)
}

@Injectable()
export class OpsAlertsService {
  private readonly logger = new Logger(OpsAlertsService.name);

  constructor(
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    private readonly config: ConfigService,
  ) {}

  async alertUnmatchedInflow(params: UnmatchedInflowAlertParams): Promise<void> {
    const recipient = this.config.get<AppConfig>('app')?.internal_alert_email;
    if (!recipient) {
      this.logger.warn(
        { reason: params.reason, order_no: params.order_no },
        'Unmatched inflow detected but INTERNAL_ALERT_EMAIL is unset — alert skipped',
      );
      return;
    }

    const subject = `[Bitmonie ops] Unmatched ${params.provider} inflow — ${params.reason}`;
    const text_body = this._buildTextBody(params);
    const html_body = this._buildHtmlBody(params);

    try {
      await this.email.sendTransactional({ to: recipient, subject, text_body, html_body });
    } catch (err) {
      // Email send failure must never escape — caller's webhook ack is more important
      // than the side-channel alert. Log loud so monitoring can pick it up.
      this.logger.error(
        {
          reason: params.reason,
          order_no: params.order_no,
          error: err instanceof Error ? err.message : String(err),
        },
        'Failed to send unmatched-inflow ops alert email',
      );
    }
  }

  private _buildTextBody(p: UnmatchedInflowAlertParams): string {
    const lines = [
      `An inbound ${p.provider} payment could not be auto-credited.`,
      '',
      `Reason:           ${REASON_LABELS[p.reason]}`,
      `Order no:         ${p.order_no}`,
      `Amount (NGN):     ${p.amount_ngn}`,
      `User ID:          ${p.user_id ?? '(unresolved)'}`,
      `Virtual account:  ${p.virtual_account ?? '(none)'}`,
    ];
    if (p.payer_name)    lines.push(`Payer name:       ${p.payer_name}`);
    if (p.payer_account) lines.push(`Payer account:    ${p.payer_account}`);
    if (p.loan_id)       lines.push(`Loan ID:          ${p.loan_id}`);
    if (p.detail)        lines.push(`Detail:           ${p.detail}`);
    lines.push('', 'The Inflow row has been persisted with is_matched=false. Triage in the database.');
    return lines.join('\n');
  }

  private _buildHtmlBody(p: UnmatchedInflowAlertParams): string {
    const row = (label: string, value: string | null | undefined) =>
      `<tr><td style="padding:4px 12px 4px 0;color:#666"><b>${label}</b></td><td style="padding:4px 0">${escapeHtml(value ?? '')}</td></tr>`;

    return `
      <p>An inbound <b>${escapeHtml(p.provider)}</b> payment could not be auto-credited.</p>
      <table style="font-family:system-ui,sans-serif;font-size:14px">
        ${row('Reason',          REASON_LABELS[p.reason])}
        ${row('Order no',        p.order_no)}
        ${row('Amount (NGN)',    p.amount_ngn)}
        ${row('User ID',         p.user_id ?? '(unresolved)')}
        ${row('Virtual account', p.virtual_account ?? '(none)')}
        ${p.payer_name    ? row('Payer name',    p.payer_name)    : ''}
        ${p.payer_account ? row('Payer account', p.payer_account) : ''}
        ${p.loan_id       ? row('Loan ID',       p.loan_id)       : ''}
        ${p.detail        ? row('Detail',        p.detail)        : ''}
      </table>
      <p style="color:#666;font-size:13px">
        The Inflow row has been persisted with <code>is_matched=false</code>. Triage in the database.
      </p>
    `.trim();
  }
}

const REASON_LABELS: Record<UnmatchedInflowReason, string> = {
  no_user_for_va:        'No user for virtual account',
  below_floor:           'Amount below partial-repayment floor (N10,000)',
  no_active_loans:       'User has no ACTIVE loans',
  multiple_active_loans: 'User has multiple ACTIVE loans (claim path required)',
  credit_failed:         'creditInflow threw — investigate stack trace',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' :
                '&#39;',
  );
}
