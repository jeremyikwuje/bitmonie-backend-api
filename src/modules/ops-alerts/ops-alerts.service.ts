import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EMAIL_PROVIDER, type EmailProvider } from '@/modules/auth/email.provider.interface';
import type { AppConfig } from '@/config/app.config';

// Reasons accepted by alertUnmatchedInflow — must stay in sync with the
// UnmatchedReason union in palmpay-collection-va.webhook.controller.ts.
// (Co-located by intent since these are the only producers + consumers.)
//
// requery_unconfirmed → PalmPay's order-query couldn't confirm settlement
//                       (status='unknown' or transient query failure).
// requery_mismatch    → PalmPay's order-query confirmed an order but the
//                       amount or virtual-account fields disagreed with the
//                       webhook payload. Treat as untrusted; do not credit.
export type UnmatchedInflowReason =
  | 'no_user_for_va'
  | 'below_floor'
  | 'no_active_loans'
  | 'multiple_active_loans'
  | 'credit_failed'
  | 'requery_unconfirmed'
  | 'requery_mismatch';

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

export interface DisbursementOnHoldAlertParams {
  disbursement_id: string;
  user_id:         string;
  source_type:     string;
  source_id:       string;
  amount:          string;
  currency:        string;
  provider_name:   string;
  account_unique:  string;
  account_name:    string | null;
  attempt_number:  number;
  failure_reason:  string;
  failure_code?:   string;
}

export interface DisbursementOnHoldDigestRow {
  disbursement_id: string;
  user_id:         string;
  source_id:       string;
  amount:          string;
  currency:        string;
  on_hold_at:      Date;
  attempt_count:   number;
  failure_reason:  string | null;
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

  // First-transition alert. Fired once when a disbursement first lands in
  // ON_HOLD after an outflow attempt failed. Subsequent failures on the same
  // disbursement are suppressed by OutflowsService (it consults
  // markOnHold().is_first_transition before calling this) and surface via
  // the daily digest instead.
  async alertDisbursementOnHold(params: DisbursementOnHoldAlertParams): Promise<void> {
    const recipient = this.config.get<AppConfig>('app')?.internal_alert_email;
    if (!recipient) {
      this.logger.warn(
        { disbursement_id: params.disbursement_id },
        'Disbursement on hold but INTERNAL_ALERT_EMAIL is unset — alert skipped',
      );
      return;
    }

    const subject   = `[Bitmonie ops] Disbursement on hold — attempt #${params.attempt_number} failed`;
    const text_body = this._buildOnHoldTextBody(params);
    const html_body = this._buildOnHoldHtmlBody(params);

    try {
      await this.email.sendTransactional({ to: recipient, subject, text_body, html_body });
    } catch (err) {
      this.logger.error(
        {
          disbursement_id: params.disbursement_id,
          error: err instanceof Error ? err.message : String(err),
        },
        'Failed to send disbursement-on-hold ops alert email',
      );
    }
  }

  // Daily digest of every disbursement still ON_HOLD. Sent by the digest
  // worker — empty digests are skipped by the caller (no signal = no email).
  async alertDisbursementOnHoldDigest(rows: DisbursementOnHoldDigestRow[]): Promise<void> {
    const recipient = this.config.get<AppConfig>('app')?.internal_alert_email;
    if (!recipient) {
      this.logger.warn({ row_count: rows.length }, 'Disbursement on-hold digest but INTERNAL_ALERT_EMAIL is unset — digest skipped');
      return;
    }

    const subject   = `[Bitmonie ops] Disbursement on-hold digest — ${rows.length} stuck`;
    const text_body = this._buildDigestTextBody(rows);
    const html_body = this._buildDigestHtmlBody(rows);

    try {
      await this.email.sendTransactional({ to: recipient, subject, text_body, html_body });
    } catch (err) {
      this.logger.error(
        { row_count: rows.length, error: err instanceof Error ? err.message : String(err) },
        'Failed to send disbursement on-hold digest email',
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

  private _buildOnHoldTextBody(p: DisbursementOnHoldAlertParams): string {
    const lines = [
      `An outflow attempt failed and the disbursement is now on hold pending ops review.`,
      '',
      `Disbursement ID:  ${p.disbursement_id}`,
      `User ID:          ${p.user_id}`,
      `Source:           ${p.source_type} ${p.source_id}`,
      `Amount:           ${p.amount} ${p.currency}`,
      `Destination:      ${p.provider_name} / ${p.account_unique}${p.account_name ? ` (${p.account_name})` : ''}`,
      `Attempt #:        ${p.attempt_number}`,
      `Failure reason:   ${p.failure_reason}`,
    ];
    if (p.failure_code) lines.push(`Failure code:     ${p.failure_code}`);
    lines.push(
      '',
      'Decide via /v1/ops/disbursements/:id — POST .../retry to dispatch a new outflow attempt, or POST .../cancel with a reason to terminally close.',
    );
    return lines.join('\n');
  }

  private _buildOnHoldHtmlBody(p: DisbursementOnHoldAlertParams): string {
    const row = (label: string, value: string | null | undefined) =>
      `<tr><td style="padding:4px 12px 4px 0;color:#666"><b>${label}</b></td><td style="padding:4px 0">${escapeHtml(value ?? '')}</td></tr>`;

    return `
      <p>An outflow attempt failed and the disbursement is now <b>on hold</b> pending ops review.</p>
      <table style="font-family:system-ui,sans-serif;font-size:14px">
        ${row('Disbursement ID', p.disbursement_id)}
        ${row('User ID',         p.user_id)}
        ${row('Source',          `${p.source_type} ${p.source_id}`)}
        ${row('Amount',          `${p.amount} ${p.currency}`)}
        ${row('Destination',     `${p.provider_name} / ${p.account_unique}${p.account_name ? ` (${p.account_name})` : ''}`)}
        ${row('Attempt #',       String(p.attempt_number))}
        ${row('Failure reason',  p.failure_reason)}
        ${p.failure_code ? row('Failure code', p.failure_code) : ''}
      </table>
      <p style="color:#666;font-size:13px">
        Decide via <code>/v1/ops/disbursements/:id</code> — <code>POST .../retry</code> to dispatch a new outflow attempt, or <code>POST .../cancel</code> with a reason to terminally close.
      </p>
    `.trim();
  }

  private _buildDigestTextBody(rows: DisbursementOnHoldDigestRow[]): string {
    const lines = [
      `${rows.length} disbursement${rows.length === 1 ? '' : 's'} still on hold. Each is awaiting a retry or cancel decision.`,
      '',
    ];
    for (const r of rows) {
      lines.push(
        `• ${r.disbursement_id} — ${r.amount} ${r.currency} — user ${r.user_id} — source ${r.source_id}`,
        `    on_hold_at=${r.on_hold_at.toISOString()} attempts=${r.attempt_count} reason=${r.failure_reason ?? '(unknown)'}`,
      );
    }
    return lines.join('\n');
  }

  private _buildDigestHtmlBody(rows: DisbursementOnHoldDigestRow[]): string {
    const cell = (v: string) => `<td style="padding:4px 12px 4px 0">${escapeHtml(v)}</td>`;
    const row  = (r: DisbursementOnHoldDigestRow) => `
      <tr>
        ${cell(r.disbursement_id)}
        ${cell(`${r.amount} ${r.currency}`)}
        ${cell(r.user_id)}
        ${cell(r.source_id)}
        ${cell(r.on_hold_at.toISOString())}
        ${cell(String(r.attempt_count))}
        ${cell(r.failure_reason ?? '(unknown)')}
      </tr>
    `;
    return `
      <p><b>${rows.length}</b> disbursement${rows.length === 1 ? '' : 's'} still on hold. Each is awaiting a retry or cancel decision.</p>
      <table style="font-family:system-ui,sans-serif;font-size:13px;border-collapse:collapse">
        <thead><tr style="text-align:left;color:#666">
          <th>Disbursement</th><th>Amount</th><th>User</th><th>Source</th><th>On hold since</th><th>Attempts</th><th>Reason</th>
        </tr></thead>
        <tbody>${rows.map(row).join('')}</tbody>
      </table>
    `.trim();
  }
}

const REASON_LABELS: Record<UnmatchedInflowReason, string> = {
  no_user_for_va:        'No user for virtual account',
  below_floor:           'Amount below partial-repayment floor (N10,000)',
  no_active_loans:       'User has no ACTIVE loans',
  multiple_active_loans: 'User has multiple ACTIVE loans (claim path required)',
  credit_failed:         'creditInflow threw — investigate stack trace',
  requery_unconfirmed:   'PalmPay order-query did not confirm settlement',
  requery_mismatch:      'PalmPay order-query disagreed with webhook (amount or VA)',
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
