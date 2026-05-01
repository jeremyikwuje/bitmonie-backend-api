// ─────────────────────────────────────────────────────────────────────────────
// Loan customer-facing notification templates — pure functions, no DB / no
// NestJS deps. Mirrors the style of reminder-templates.ts so the worker and
// the in-process notification service render identically.
//
// Covers seven lifecycle moments:
//   1. Loan created           — awaiting BTC collateral
//   2. Collateral received    — disbursement in progress
//   3. Loan disbursed         — funds sent
//   4. Repayment partial      — receipt + waterfall + remaining balance
//   5. Repayment full         — loan cleared, collateral release in progress
//   6. Collateral topped up   — protection increased
//   7. Collateral released    — SAT sent back to customer (REPAID follow-up)
// ─────────────────────────────────────────────────────────────────────────────

export interface NotificationEmail {
  subject:   string;
  text_body: string;
  html_body: string;
}

export interface RepaymentAccountSummary {
  virtual_account_no:   string;
  virtual_account_name: string;
  bank_name:            string;
}

export interface LoanCreatedParams {
  first_name:                   string | null;
  loan_id:                      string;
  principal_ngn:                string;     // pre-formatted, 2dp
  origination_fee_ngn:          string;     // pre-formatted, 2dp
  amount_to_receive_ngn:        string;     // pre-formatted, 2dp — net of origination
  amount_to_repay_estimate_ngn: string;     // pre-formatted, 2dp — over chosen term
  collateral_amount_sat:        bigint;
  duration_days:                number;
  expires_at:                   Date;
}

export interface CollateralReceivedParams {
  first_name:    string | null;
  loan_id:       string;
  principal_ngn: string;             // pre-formatted, 2dp
  duration_days: number;
  due_at:        Date;
}

export interface LoanDisbursedParams {
  first_name:          string | null;
  loan_id:             string;
  amount_ngn:          string;         // pre-formatted, 2dp — what hit the customer's bank (netted)
  principal_ngn:       string;         // pre-formatted, 2dp — gross loan amount
  origination_fee_ngn: string;         // pre-formatted, 2dp — netted from disbursement
  bank_name:           string;
  account_unique:      string;
  account_name:        string | null;
  due_at:              Date;
  repayment_account:   RepaymentAccountSummary;
}

export interface RepaymentParams {
  first_name:           string | null;
  loan_id:              string;
  amount_paid_ngn:      string;      // pre-formatted, 2dp
  applied_to_custody:   string;
  applied_to_interest:  string;
  applied_to_principal: string;
  overpay_ngn:          string;
  outstanding_ngn:      string;      // 0.00 when fully repaid
  is_fully_repaid:      boolean;
  repayment_account:    RepaymentAccountSummary;   // shown only on partial
}

export interface CollateralToppedUpParams {
  first_name:               string | null;
  loan_id:                  string;
  added_sat:                bigint;
  new_total_collateral_sat: bigint;
}

export interface CollateralReleasedParams {
  first_name:         string | null;
  loan_id:            string;
  amount_sat:         bigint;
  release_address:    string;
  provider_reference: string;
  released_at:        Date;
}

// ── helpers (kept local; reminder-templates.ts has its own copy) ─────────────

const FOOTER_TEXT = '\n\n— Bitmonie';
const FOOTER_HTML = '<p style="color:#666;font-size:12px;margin-top:20px">— Bitmonie</p>';

const NGN = (amount: string) => `₦${formatThousands(amount)}`;

function formatThousands(amount: string): string {
  const [whole, frac = '00'] = amount.split('.');
  const grouped = (whole ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${grouped}.${frac}`;
}

function formatSats(sats: bigint): string {
  return sats.toLocaleString('en-US') + ' sats';
}

function shortLoanId(loan_id: string): string {
  return loan_id.replace(/-/g, '').slice(0, 8).toUpperCase();
}

function greet(first_name: string | null): string {
  return first_name ? `Hi ${first_name}` : 'Hi';
}

function paymentBlock(va: RepaymentAccountSummary): string {
  return `Pay to:\n  Bank:            ${va.bank_name}\n  Account name:    ${va.virtual_account_name}\n  Account number:  ${va.virtual_account_no}`;
}

function paymentBlockHtml(va: RepaymentAccountSummary): string {
  return `<p style="margin:12px 0">Pay to:<br><b>${escapeHtml(va.bank_name)}</b><br><b>${escapeHtml(va.virtual_account_name)}</b><br><code style="font-size:16px">${escapeHtml(va.virtual_account_no)}</code></p>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' :
                '&#39;',
  );
}

// ── 1. Loan created ──────────────────────────────────────────────────────────

export function buildLoanCreatedEmail(p: LoanCreatedParams): NotificationEmail {
  const sid = shortLoanId(p.loan_id);
  const principal       = NGN(p.principal_ngn);
  const origination     = NGN(p.origination_fee_ngn);
  const amount_receive  = NGN(p.amount_to_receive_ngn);
  const amount_repay    = NGN(p.amount_to_repay_estimate_ngn);
  const sats            = formatSats(p.collateral_amount_sat);
  const term            = `${p.duration_days} day${p.duration_days === 1 ? '' : 's'}`;

  return {
    subject: `Your Bitmonie loan ${sid} is awaiting collateral`,
    text_body:
      `${greet(p.first_name)},\n\n` +
      `Your Bitmonie loan ${sid} has been created. We're now waiting for your BTC collateral.\n\n` +
      `  Loan amount:        ${principal}\n` +
      `  Origination fee:    −${origination}\n` +
      `  You will receive:   ${amount_receive}\n` +
      `  Estimated repayment: ${amount_repay} over ${term}\n` +
      `  Collateral needed:  ${sats}\n` +
      `  Term:               ${term}\n\n` +
      `Pay the Lightning invoice in your dashboard before ${p.expires_at.toUTCString()}.\n` +
      `Once collateral is received, ${amount_receive} will be disbursed to your default account immediately. ` +
      `Repayment is estimated at ${amount_repay} (interest 0.3%/day on outstanding principal + fixed daily custody — actuals accrue).${FOOTER_TEXT}`,
    html_body:
      `<p>${greet(p.first_name)},</p>` +
      `<p>Your Bitmonie loan <code>${sid}</code> has been created. We're now waiting for your BTC collateral.</p>` +
      `<table style="font-family:system-ui,sans-serif;font-size:14px">` +
        row('Loan amount',         principal) +
        row('Origination fee',     `−${origination}`) +
        row('You will receive',    amount_receive) +
        row('Estimated repayment', `${amount_repay} over ${term}`) +
        row('Collateral needed',   sats) +
        row('Term',                term) +
      `</table>` +
      `<p>Pay the Lightning invoice in your dashboard before <b>${escapeHtml(p.expires_at.toUTCString())}</b>.</p>` +
      `<p>Once collateral is received, <b>${amount_receive}</b> will be disbursed to your default account immediately. ` +
      `Repayment is estimated at <b>${amount_repay}</b> (interest 0.3%/day on outstanding principal + fixed daily custody — actuals accrue).</p>` +
      FOOTER_HTML,
  };
}

// ── 2. Collateral received ───────────────────────────────────────────────────

export function buildCollateralReceivedEmail(p: CollateralReceivedParams): NotificationEmail {
  const sid = shortLoanId(p.loan_id);
  const principal = NGN(p.principal_ngn);

  return {
    subject: `Bitmonie loan ${sid} — collateral confirmed, disbursing now`,
    text_body:
      `${greet(p.first_name)},\n\n` +
      `We've received your BTC collateral for loan ${sid}. ${principal} is being disbursed to your default account now.\n\n` +
      `  Principal:      ${principal}\n` +
      `  Term:           ${p.duration_days} day${p.duration_days === 1 ? '' : 's'}\n` +
      `  Maturity date:  ${p.due_at.toDateString()}\n\n` +
      `Interest accrues daily at 0.3% on outstanding principal. Custody fees accrue at a fixed daily rate set at origination.\n` +
      `You can repay any time before maturity to save on fees.${FOOTER_TEXT}`,
    html_body:
      `<p>${greet(p.first_name)},</p>` +
      `<p>We've received your BTC collateral for loan <code>${sid}</code>. <b>${principal}</b> is being disbursed to your default account now.</p>` +
      `<table style="font-family:system-ui,sans-serif;font-size:14px">` +
        row('Principal',     principal) +
        row('Term',          `${p.duration_days} day${p.duration_days === 1 ? '' : 's'}`) +
        row('Maturity date', p.due_at.toDateString()) +
      `</table>` +
      `<p>Interest accrues daily at 0.3% on outstanding principal. Custody fees accrue at a fixed daily rate set at origination. You can repay any time before maturity to save on fees.</p>` +
      FOOTER_HTML,
  };
}

// ── 3. Loan disbursed ────────────────────────────────────────────────────────

export function buildLoanDisbursedEmail(p: LoanDisbursedParams): NotificationEmail {
  const sid = shortLoanId(p.loan_id);
  const amount      = NGN(p.amount_ngn);
  const principal   = NGN(p.principal_ngn);
  const origination = NGN(p.origination_fee_ngn);
  const account_line = p.account_name ? `${p.account_unique} (${p.account_name})` : p.account_unique;

  return {
    subject: `Bitmonie loan ${sid} — ${amount} disbursed`,
    text_body:
      `${greet(p.first_name)},\n\n` +
      `${amount} has been sent to your account for loan ${sid}.\n\n` +
      `  Loan amount:    ${principal}\n` +
      `  Origination fee: −${origination}\n` +
      `  You received:   ${amount}\n\n` +
      `  Bank:           ${p.bank_name}\n` +
      `  Account:        ${account_line}\n\n` +
      `Loan due: ${p.due_at.toDateString()}.\n\n` +
      `When you're ready to repay (in part or in full):\n` +
      `${paymentBlock(p.repayment_account)}${FOOTER_TEXT}`,
    html_body:
      `<p>${greet(p.first_name)},</p>` +
      `<p><b>${amount}</b> has been sent to your account for loan <code>${sid}</code>.</p>` +
      `<table style="font-family:system-ui,sans-serif;font-size:14px">` +
        row('Loan amount',     principal) +
        row('Origination fee', `−${origination}`) +
        row('You received',    amount) +
        row('Bank',            p.bank_name) +
        row('Account',         account_line) +
      `</table>` +
      `<p>Loan due: <b>${escapeHtml(p.due_at.toDateString())}</b>.</p>` +
      `<p>When you're ready to repay (in part or in full):</p>` +
      paymentBlockHtml(p.repayment_account) +
      FOOTER_HTML,
  };
}

// ── 4 + 5. Repayment receipt (partial OR full) ──────────────────────────────
// One builder branches on `is_fully_repaid` — keeps the breakdown rendering
// in a single place so the partial and full receipts stay visually consistent.

export function buildRepaymentEmail(p: RepaymentParams): NotificationEmail {
  const sid = shortLoanId(p.loan_id);
  const paid = NGN(p.amount_paid_ngn);

  const breakdown_lines: string[] = [];
  const breakdown_rows:  string[] = [];
  if (parseFloat(p.applied_to_custody) > 0) {
    breakdown_lines.push(`  Custody fees paid:    ${NGN(p.applied_to_custody)}`);
    breakdown_rows.push(row('Custody fees paid',    NGN(p.applied_to_custody)));
  }
  if (parseFloat(p.applied_to_interest) > 0) {
    breakdown_lines.push(`  Interest paid:        ${NGN(p.applied_to_interest)}`);
    breakdown_rows.push(row('Interest paid',        NGN(p.applied_to_interest)));
  }
  if (parseFloat(p.applied_to_principal) > 0) {
    breakdown_lines.push(`  Principal paid:       ${NGN(p.applied_to_principal)}`);
    breakdown_rows.push(row('Principal paid',       NGN(p.applied_to_principal)));
  }
  if (parseFloat(p.overpay_ngn) > 0) {
    breakdown_lines.push(`  Overpaid (refundable): ${NGN(p.overpay_ngn)}`);
    breakdown_rows.push(row('Overpaid (refundable)', NGN(p.overpay_ngn)));
  }

  if (p.is_fully_repaid) {
    return {
      subject: `Bitmonie loan ${sid} — REPAID. Releasing your collateral.`,
      text_body:
        `${greet(p.first_name)},\n\n` +
        `Your Bitmonie loan ${sid} is fully repaid.\n\n` +
        `Final payment received: ${paid}\n\n` +
        `How we applied it:\n` +
        breakdown_lines.join('\n') + '\n\n' +
        `Outstanding balance:    ${NGN('0.00')}\n\n` +
        (parseFloat(p.overpay_ngn) > 0
          ? `You overpaid by ${NGN(p.overpay_ngn)}. Our team will reach out to arrange a refund.\n\n`
          : '') +
        `We're now releasing your BTC collateral to the Lightning address you provided at checkout. ` +
        `You'll receive a separate confirmation once the release lands.${FOOTER_TEXT}`,
      html_body:
        `<p>${greet(p.first_name)},</p>` +
        `<p>Your Bitmonie loan <code>${sid}</code> is <b>fully repaid</b>.</p>` +
        `<p>Final payment received: <b>${paid}</b></p>` +
        `<p style="margin-top:12px;color:#666"><b>How we applied it:</b></p>` +
        `<table style="font-family:system-ui,sans-serif;font-size:14px">` +
          breakdown_rows.join('') +
          row('Outstanding balance', NGN('0.00')) +
        `</table>` +
        (parseFloat(p.overpay_ngn) > 0
          ? `<p>You overpaid by <b>${NGN(p.overpay_ngn)}</b>. Our team will reach out to arrange a refund.</p>`
          : '') +
        `<p>We're now releasing your BTC collateral to the Lightning address you provided at checkout. ` +
        `You'll receive a separate confirmation once the release lands.</p>` +
        FOOTER_HTML,
    };
  }

  // Partial — loan still active, show next-payment instructions
  return {
    subject: `Bitmonie loan ${sid} — ${paid} received (partial repayment)`,
    text_body:
      `${greet(p.first_name)},\n\n` +
      `We've received ${paid} on your loan ${sid}.\n\n` +
      `How we applied it:\n` +
      breakdown_lines.join('\n') + '\n\n' +
      `Outstanding balance:  ${NGN(p.outstanding_ngn)}\n\n` +
      `Your loan is still ACTIVE. Interest and custody continue to accrue daily on the remaining principal — ` +
      `repay any amount of at least ₦10,000 to bring the balance down further.\n\n` +
      `${paymentBlock(p.repayment_account)}${FOOTER_TEXT}`,
    html_body:
      `<p>${greet(p.first_name)},</p>` +
      `<p>We've received <b>${paid}</b> on your loan <code>${sid}</code>.</p>` +
      `<p style="margin-top:12px;color:#666"><b>How we applied it:</b></p>` +
      `<table style="font-family:system-ui,sans-serif;font-size:14px">` +
        breakdown_rows.join('') +
        row('Outstanding balance', NGN(p.outstanding_ngn)) +
      `</table>` +
      `<p>Your loan is still <b>ACTIVE</b>. Interest and custody continue to accrue daily on the remaining principal — ` +
      `repay any amount of at least ₦10,000 to bring the balance down further.</p>` +
      paymentBlockHtml(p.repayment_account) +
      FOOTER_HTML,
  };
}

// ── 6. Collateral topped up ──────────────────────────────────────────────────

export function buildCollateralToppedUpEmail(p: CollateralToppedUpParams): NotificationEmail {
  const sid = shortLoanId(p.loan_id);
  const added = formatSats(p.added_sat);
  const total = formatSats(p.new_total_collateral_sat);

  return {
    subject: `Bitmonie loan ${sid} — collateral top-up confirmed`,
    text_body:
      `${greet(p.first_name)},\n\n` +
      `We've received your collateral top-up for loan ${sid}.\n\n` +
      `  Added:                ${added}\n` +
      `  New total collateral: ${total}\n\n` +
      `Your loan is now better protected against BTC price moves.${FOOTER_TEXT}`,
    html_body:
      `<p>${greet(p.first_name)},</p>` +
      `<p>We've received your collateral top-up for loan <code>${sid}</code>.</p>` +
      `<table style="font-family:system-ui,sans-serif;font-size:14px">` +
        row('Added',                added) +
        row('New total collateral', total) +
      `</table>` +
      `<p>Your loan is now better protected against BTC price moves.</p>` +
      FOOTER_HTML,
  };
}

// ── 7. Collateral released ───────────────────────────────────────────────────

export function buildCollateralReleasedEmail(p: CollateralReleasedParams): NotificationEmail {
  const sid    = shortLoanId(p.loan_id);
  const sats   = formatSats(p.amount_sat);
  const sent_at = p.released_at.toUTCString();

  return {
    subject: `Bitmonie loan ${sid} — collateral released`,
    text_body:
      `${greet(p.first_name)},\n\n` +
      `Your collateral for loan ${sid} has been released to your Lightning address.\n\n` +
      `  Amount sent:     ${sats}\n` +
      `  To:              ${p.release_address}\n` +
      `  Sent at:         ${sent_at}\n` +
      `  Reference:       ${p.provider_reference}\n\n` +
      `If you don't see it in your wallet within a few minutes, check that the address above is correct ` +
      `and reach out to support — keep the reference handy.${FOOTER_TEXT}`,
    html_body:
      `<p>${greet(p.first_name)},</p>` +
      `<p>Your collateral for loan <code>${sid}</code> has been released to your Lightning address.</p>` +
      `<table style="font-family:system-ui,sans-serif;font-size:14px">` +
        row('Amount sent', sats) +
        row('To',          p.release_address) +
        row('Sent at',     sent_at) +
        row('Reference',   p.provider_reference) +
      `</table>` +
      `<p>If you don't see it in your wallet within a few minutes, check that the address above is correct ` +
      `and reach out to support — keep the reference handy.</p>` +
      FOOTER_HTML,
  };
}

// ── shared row renderer ──────────────────────────────────────────────────────

function row(label: string, value: string): string {
  return `<tr><td style="padding:4px 12px 4px 0;color:#666"><b>${escapeHtml(label)}</b></td><td style="padding:4px 0">${escapeHtml(value)}</td></tr>`;
}
