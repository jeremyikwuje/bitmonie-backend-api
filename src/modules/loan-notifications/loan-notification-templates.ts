// ─────────────────────────────────────────────────────────────────────────────
// Loan customer-facing notification templates — pure functions, no DB / no
// NestJS deps.
//
// Covers nine lifecycle moments:
//   1. Loan created            — awaiting BTC collateral
//   2. Collateral received     — disbursement in progress
//   3. Loan disbursed          — funds sent
//   4. Repayment partial       — receipt + waterfall + remaining balance
//   5. Repayment full          — loan cleared, collateral release in progress
//   6. Collateral topped up    — protection increased
//   7. Collateral released     — SAT sent back to customer (REPAID follow-up)
//   8. Coverage warning        — informational, collateral coverage < 1.20
//   9. Margin call             — urgent, collateral coverage < 1.15
//
// Loans are open-term (no due date, no maturity). Customers repay anytime;
// daily interest + daily custody accrue until the loan closes. The only
// forced-close trigger is coverage falling below 1.10 (auto-liquidation).
// ─────────────────────────────────────────────────────────────────────────────

import { MIN_PARTIAL_REPAYMENT_NGN } from '@/common/constants';

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

// All NGN string params below are pre-formatted whole-naira integers (no
// decimal point). Producing service / worker rounds via `displayNgn(...)`
// at the boundary — `ceil` for amounts owed to us, `floor` for amounts we
// pay the customer. Templates render verbatim.

export interface LoanCreatedParams {
  first_name:            string | null;
  loan_id:               string;
  principal_ngn:         string;     // whole NGN, ceil
  origination_fee_ngn:   string;     // whole NGN, ceil
  amount_to_receive_ngn: string;     // whole NGN, floor — net of origination
  daily_interest_ngn:    string;     // whole NGN, ceil — 0.3% × principal at day 0
  daily_custody_fee_ngn: string;     // whole NGN, ceil — fixed at origination
  collateral_amount_sat: bigint;
  expires_at:            Date;
  payment_request:       string;     // BOLT11 invoice
}

export interface CollateralReceivedParams {
  first_name:            string | null;
  loan_id:               string;
  principal_ngn:         string;     // whole NGN, ceil — gross loan amount
  origination_fee_ngn:   string;     // whole NGN, ceil — netted from disbursement
  amount_to_receive_ngn: string;     // whole NGN, floor — what actually hits the bank
  daily_interest_ngn:    string;     // whole NGN, ceil
  daily_custody_fee_ngn: string;     // whole NGN, ceil
}

export interface LoanDisbursedParams {
  first_name:            string | null;
  loan_id:               string;
  amount_ngn:            string;         // whole NGN, floor — what hit the customer's bank (netted)
  principal_ngn:         string;         // whole NGN, ceil — gross loan amount
  origination_fee_ngn:   string;         // whole NGN, ceil — netted from disbursement
  daily_interest_ngn:    string;         // whole NGN, ceil
  daily_custody_fee_ngn: string;         // whole NGN, ceil
  bank_name:             string;
  account_unique:        string;
  account_name:          string | null;
  repayment_account:     RepaymentAccountSummary;
}

export interface CoverageWarnParams {
  first_name:        string | null;
  loan_id:           string;
  coverage_percent:  string;     // e.g. "118" — collateral as % of outstanding
  outstanding_ngn:   string;     // whole NGN, ceil
  collateral_amount_sat: bigint;
  repayment_account: RepaymentAccountSummary;
}

export interface MarginCallParams {
  first_name:        string | null;
  loan_id:           string;
  coverage_percent:  string;     // e.g. "112" — collateral as % of outstanding
  outstanding_ngn:   string;     // whole NGN, ceil
  collateral_amount_sat: bigint;
  repayment_account: RepaymentAccountSummary;
}

export interface RepaymentParams {
  first_name:                 string | null;
  loan_id:                    string;
  amount_paid_ngn:            string;      // whole NGN, ceil
  applied_to_custody:         string;      // whole NGN, ceil
  applied_to_interest:        string;      // whole NGN, ceil
  applied_to_principal:       string;      // whole NGN, ceil
  overpay_ngn:                string;      // whole NGN, floor — refundable to customer
  outstanding_ngn:            string;      // whole NGN, ceil — "0" when fully repaid
  is_fully_repaid:            boolean;
  repayment_account:          RepaymentAccountSummary;   // shown only on partial
  collateral_amount_sat:      bigint;                    // shown only on full
  collateral_release_address: string | null;             // shown only on full; nullable per §5.4a
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

// Input is a whole-naira integer string ("50000"). Producing service rounds
// kobo away at the boundary; templates only ever render whole naira.
function formatThousands(amount: string): string {
  const [whole = ''] = amount.split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
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
  // Account number rendered as a styled span (not <code>) — Gmail iOS and a
  // few other mobile clients ignore inline font-size on <code> and fall back
  // to a small monospace default, which made the digits hard to read on
  // phones. Explicit size + weight + monospace stack survives the common
  // email-client style strippers and stays legible.
  return `<p style="margin:12px 0">Pay to:<br><b>${escapeHtml(va.bank_name)}</b><br><b>${escapeHtml(va.virtual_account_name)}</b><br><span style="font-size:20px;font-weight:700;letter-spacing:0.5px;font-family:Menlo,Consolas,monospace">${escapeHtml(va.virtual_account_no)}</span></p>`;
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
  const sid              = shortLoanId(p.loan_id);
  const principal        = NGN(p.principal_ngn);
  const origination      = NGN(p.origination_fee_ngn);
  const amount_receive   = NGN(p.amount_to_receive_ngn);
  const daily_interest   = NGN(p.daily_interest_ngn);
  const daily_custody    = NGN(p.daily_custody_fee_ngn);
  const sats             = formatSats(p.collateral_amount_sat);

  return {
    subject: `Your Bitmonie loan ${sid} is awaiting collateral`,
    text_body:
      `${greet(p.first_name)},\n\n` +
      `Your Bitmonie loan ${sid} has been created. We're now waiting for your BTC collateral.\n\n` +
      `  Loan amount:        ${principal}\n` +
      `  Origination fee:    −${origination}\n` +
      `  You will receive:   ${amount_receive}\n` +
      `  Daily interest:     ${daily_interest}\n` +
      `  Daily custody:      ${daily_custody}\n` +
      `  Collateral needed:  ${sats}\n\n` +
      `Pay the Lightning invoice in your dashboard before ${p.expires_at.toUTCString()}, or copy the invoice below into any Lightning wallet:\n\n` +
      `${p.payment_request}\n\n` +
      `Once collateral is received, ${amount_receive} will be disbursed to your default account immediately. ` +
      `Repay any time — interest (0.3%/day on outstanding principal) and custody accrue daily until the loan closes.${FOOTER_TEXT}`,
    html_body:
      `<p>${greet(p.first_name)},</p>` +
      `<p>Your Bitmonie loan <code>${sid}</code> has been created. We're now waiting for your BTC collateral.</p>` +
      `<table style="font-family:system-ui,sans-serif;font-size:14px">` +
        row('Loan amount',        principal) +
        row('Origination fee',    `−${origination}`) +
        row('You will receive',   amount_receive) +
        row('Daily interest',     daily_interest) +
        row('Daily custody',      daily_custody) +
        row('Collateral needed',  sats) +
      `</table>` +
      `<p>Pay the Lightning invoice in your dashboard before <b>${escapeHtml(p.expires_at.toUTCString())}</b>, or copy the invoice below into any Lightning wallet:</p>` +
      `<p style="font-style:italic;font-family:Menlo,Consolas,monospace;font-size:12px;word-break:break-all;background:#f5f5f5;padding:10px;border-radius:4px;color:#333">${escapeHtml(p.payment_request)}</p>` +
      `<p>Once collateral is received, <b>${amount_receive}</b> will be disbursed to your default account immediately. ` +
      `Repay any time — interest (0.3%/day on outstanding principal) and custody accrue daily until the loan closes.</p>` +
      FOOTER_HTML,
  };
}

// ── 2. Collateral received ───────────────────────────────────────────────────

export function buildCollateralReceivedEmail(p: CollateralReceivedParams): NotificationEmail {
  const sid             = shortLoanId(p.loan_id);
  const principal       = NGN(p.principal_ngn);
  const origination     = NGN(p.origination_fee_ngn);
  const net_amount      = NGN(p.amount_to_receive_ngn);
  const daily_interest  = NGN(p.daily_interest_ngn);
  const daily_custody   = NGN(p.daily_custody_fee_ngn);

  return {
    subject: `Bitmonie loan ${sid} — collateral confirmed, disbursing now`,
    text_body:
      `${greet(p.first_name)},\n\n` +
      `We've received your BTC collateral for loan ${sid}. ${net_amount} is being disbursed to your default account now (${principal} less ${origination} origination fee).\n\n` +
      `  Loan amount:     ${principal}\n` +
      `  Origination fee: −${origination}\n` +
      `  You'll receive:  ${net_amount}\n` +
      `  Daily interest:  ${daily_interest}\n` +
      `  Daily custody:   ${daily_custody}\n\n` +
      `Repay any time. Interest (0.3%/day on outstanding principal) and custody accrue daily until you repay.${FOOTER_TEXT}`,
    html_body:
      `<p>${greet(p.first_name)},</p>` +
      `<p>We've received your BTC collateral for loan <code>${sid}</code>. <b>${net_amount}</b> is being disbursed to your default account now (${principal} less ${origination} origination fee).</p>` +
      `<table style="font-family:system-ui,sans-serif;font-size:14px">` +
        row('Loan amount',     principal) +
        row('Origination fee', `−${origination}`) +
        row("You'll receive",  net_amount) +
        row('Daily interest',  daily_interest) +
        row('Daily custody',   daily_custody) +
      `</table>` +
      `<p>Repay any time. Interest (0.3%/day on outstanding principal) and custody accrue daily until you repay.</p>` +
      FOOTER_HTML,
  };
}

// ── 3. Loan disbursed ────────────────────────────────────────────────────────

export function buildLoanDisbursedEmail(p: LoanDisbursedParams): NotificationEmail {
  const sid            = shortLoanId(p.loan_id);
  const amount         = NGN(p.amount_ngn);
  const principal      = NGN(p.principal_ngn);
  const origination    = NGN(p.origination_fee_ngn);
  const daily_interest = NGN(p.daily_interest_ngn);
  const daily_custody  = NGN(p.daily_custody_fee_ngn);
  const account_line   = p.account_name ? `${p.account_unique} (${p.account_name})` : p.account_unique;

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
      `Daily charges accrue:\n` +
      `  Interest:       ${daily_interest}\n` +
      `  Custody:        ${daily_custody}\n\n` +
      `Repay any time — the longer you hold, the more interest and custody accrue. ` +
      `If your collateral coverage drops below 110%, the loan auto-liquidates.\n\n` +
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
        row('Daily interest',  daily_interest) +
        row('Daily custody',   daily_custody) +
      `</table>` +
      `<p>Repay any time — the longer you hold, the more interest and custody accrue. ` +
      `If your collateral coverage drops below 110%, the loan auto-liquidates.</p>` +
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
    const sats = formatSats(p.collateral_amount_sat);
    const has_address = p.collateral_release_address !== null && p.collateral_release_address.length > 0;

    // Two paths — the address may legitimately still be null at this point
    // (CLAUDE.md §5.4a: a loan can sit at REPAID with collateral_released_at
    // NULL while the customer enters their Lightning address). The release
    // worker picks it up the moment the address is set.
    const release_text = has_address
      ? `We're now releasing your ${sats} collateral to your Lightning address:\n\n` +
        `  ${p.collateral_release_address}\n\n` +
        `Double-check the address — Lightning sends are irreversible, and a wrong address means lost funds. ` +
        `If it's wrong, update it from your Bitmonie account before the release goes out. ` +
        `You'll receive a separate confirmation once the release lands.`
      : `Your ${sats} collateral is ready to be released. ` +
        `Add your Lightning address from your Bitmonie account to start the release — ` +
        `your collateral stays safe until you do. ` +
        `Double-check the address before saving — Lightning sends are irreversible, and a wrong address means lost funds.`;

    const release_html = has_address
      ? `<p>We're now releasing your <b>${sats}</b> collateral to your Lightning address:</p>` +
        `<p style="margin:12px 0"><span style="font-size:16px;font-weight:700;letter-spacing:0.3px;font-family:Menlo,Consolas,monospace;word-break:break-all">${escapeHtml(p.collateral_release_address!)}</span></p>` +
        `<p style="color:#a00"><b>Double-check the address.</b> Lightning sends are irreversible, and a wrong address means lost funds. ` +
        `If it's wrong, update it from your Bitmonie account before the release goes out.</p>` +
        `<p>You'll receive a separate confirmation once the release lands.</p>`
      : `<p>Your <b>${sats}</b> collateral is ready to be released. ` +
        `Add your Lightning address from your Bitmonie account to start the release — your collateral stays safe until you do.</p>` +
        `<p style="color:#a00"><b>Double-check the address before saving.</b> Lightning sends are irreversible, and a wrong address means lost funds.</p>`;

    return {
      subject: `Bitmonie loan ${sid} — REPAID. Releasing your collateral.`,
      text_body:
        `${greet(p.first_name)},\n\n` +
        `Your Bitmonie loan ${sid} is fully repaid.\n\n` +
        `Final payment received: ${paid}\n\n` +
        `How we applied it:\n` +
        breakdown_lines.join('\n') + '\n\n' +
        `Outstanding balance:    ${NGN('0')}\n\n` +
        (parseFloat(p.overpay_ngn) > 0
          ? `You overpaid by ${NGN(p.overpay_ngn)}. Our team will reach out to arrange a refund.\n\n`
          : '') +
        `${release_text}${FOOTER_TEXT}`,
      html_body:
        `<p>${greet(p.first_name)},</p>` +
        `<p>Your Bitmonie loan <code>${sid}</code> is <b>fully repaid</b>.</p>` +
        `<p>Final payment received: <b>${paid}</b></p>` +
        `<p style="margin-top:12px;color:#666"><b>How we applied it:</b></p>` +
        `<table style="font-family:system-ui,sans-serif;font-size:14px">` +
          breakdown_rows.join('') +
          row('Outstanding balance', NGN('0')) +
        `</table>` +
        (parseFloat(p.overpay_ngn) > 0
          ? `<p>You overpaid by <b>${NGN(p.overpay_ngn)}</b>. Our team will reach out to arrange a refund.</p>`
          : '') +
        release_html +
        FOOTER_HTML,
    };
  }

  // Partial — loan still active, show next-payment instructions.
  //
  // When outstanding has accrued down below the ₦10,000 partial-repayment
  // floor, the standard "any amount ≥ ₦10,000" guidance becomes wrong: the
  // customer either has to overpay or send the exact outstanding (which the
  // collection webhook now bypasses the floor for, see palmpay-collection-va).
  // Branch the copy so the customer is told to send the exact outstanding
  // to close the loan in full.
  const outstanding_below_floor =
    parseFloat(p.outstanding_ngn) < MIN_PARTIAL_REPAYMENT_NGN.toNumber();

  const next_payment_text = outstanding_below_floor
    ? `Pay exactly ${NGN(p.outstanding_ngn)} to close this loan in full. ` +
      `Interest and custody continue to accrue daily until the loan closes.`
    : `Your loan is still ACTIVE. Interest and custody continue to accrue daily on the remaining principal — ` +
      `repay any amount of at least ₦10,000 to bring the balance down further.`;

  const next_payment_html = outstanding_below_floor
    ? `<p>Pay exactly <b>${NGN(p.outstanding_ngn)}</b> to close this loan in full. ` +
      `Interest and custody continue to accrue daily until the loan closes.</p>`
    : `<p>Your loan is still <b>ACTIVE</b>. Interest and custody continue to accrue daily on the remaining principal — ` +
      `repay any amount of at least ₦10,000 to bring the balance down further.</p>`;

  return {
    subject: `Bitmonie loan ${sid} — ${paid} received (partial repayment)`,
    text_body:
      `${greet(p.first_name)},\n\n` +
      `We've received ${paid} on your loan ${sid}.\n\n` +
      `How we applied it:\n` +
      breakdown_lines.join('\n') + '\n\n' +
      `Outstanding balance:  ${NGN(p.outstanding_ngn)}\n\n` +
      `${next_payment_text}\n\n` +
      `${paymentBlock(p.repayment_account)}${FOOTER_TEXT}`,
    html_body:
      `<p>${greet(p.first_name)},</p>` +
      `<p>We've received <b>${paid}</b> on your loan <code>${sid}</code>.</p>` +
      `<p style="margin-top:12px;color:#666"><b>How we applied it:</b></p>` +
      `<table style="font-family:system-ui,sans-serif;font-size:14px">` +
        breakdown_rows.join('') +
        row('Outstanding balance', NGN(p.outstanding_ngn)) +
      `</table>` +
      next_payment_html +
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

// ── 8. Coverage warning (collateral coverage < 1.20 — informational) ─────────

export function buildCoverageWarnEmail(p: CoverageWarnParams): NotificationEmail {
  const sid          = shortLoanId(p.loan_id);
  const coverage     = `${p.coverage_percent}%`;
  const outstanding  = NGN(p.outstanding_ngn);
  const sats         = formatSats(p.collateral_amount_sat);

  return {
    subject: `Bitmonie loan ${sid} — collateral coverage is dropping`,
    text_body:
      `${greet(p.first_name)},\n\n` +
      `The BTC market has moved against your loan ${sid}. Your collateral coverage is now ${coverage}.\n\n` +
      `  Coverage:        ${coverage} (we liquidate at 110%)\n` +
      `  Outstanding:     ${outstanding}\n` +
      `  Collateral:      ${sats}\n\n` +
      `Two ways to improve your coverage:\n\n` +
      `  1. Top up collateral. Send more BTC via the "Add collateral" flow in your dashboard. ` +
      `Your existing collateral stays put — the top-up adds to it.\n\n` +
      `  2. Repay (in part or in full). Pay any amount to your repayment account:\n\n` +
      `${paymentBlock(p.repayment_account)}\n\n` +
      `If coverage drops to 110%, we'll liquidate automatically to protect the loan.${FOOTER_TEXT}`,
    html_body:
      `<p>${greet(p.first_name)},</p>` +
      `<p>The BTC market has moved against your loan <code>${sid}</code>. Your collateral coverage is now <b>${coverage}</b>.</p>` +
      `<table style="font-family:system-ui,sans-serif;font-size:14px">` +
        row('Coverage',    `${coverage} (we liquidate at 110%)`) +
        row('Outstanding', outstanding) +
        row('Collateral',  sats) +
      `</table>` +
      `<p>Two ways to improve your coverage:</p>` +
      `<ol>` +
        `<li><b>Top up collateral.</b> Send more BTC via the "Add collateral" flow in your dashboard. Your existing collateral stays put — the top-up adds to it.</li>` +
        `<li><b>Repay (in part or in full).</b> Pay any amount to your repayment account:</li>` +
      `</ol>` +
      paymentBlockHtml(p.repayment_account) +
      `<p>If coverage drops to 110%, we'll liquidate automatically to protect the loan.</p>` +
      FOOTER_HTML,
  };
}

// ── 9. Margin call (collateral coverage < 1.15 — urgent) ─────────────────────

export function buildMarginCallEmail(p: MarginCallParams): NotificationEmail {
  const sid          = shortLoanId(p.loan_id);
  const coverage     = `${p.coverage_percent}%`;
  const outstanding  = NGN(p.outstanding_ngn);
  const sats         = formatSats(p.collateral_amount_sat);

  return {
    subject: `MARGIN CALL — Bitmonie loan ${sid} (coverage ${coverage})`,
    text_body:
      `${greet(p.first_name)},\n\n` +
      `URGENT: your loan ${sid} is at margin call. Coverage is ${coverage} — only ${marginToLiquidationCopy(p.coverage_percent)} away from auto-liquidation at 110%.\n\n` +
      `  Coverage:        ${coverage}\n` +
      `  Outstanding:     ${outstanding}\n` +
      `  Collateral:      ${sats}\n\n` +
      `Act immediately. Two options:\n\n` +
      `  1. Top up collateral. Use the "Add collateral" flow to send more BTC.\n\n` +
      `  2. Repay (in part or in full). Pay any amount to your repayment account:\n\n` +
      `${paymentBlock(p.repayment_account)}\n\n` +
      `If coverage drops to 110%, the loan auto-liquidates — no further notice. ` +
      `If BTC moves quickly, liquidation can happen in minutes.${FOOTER_TEXT}`,
    html_body:
      `<p>${greet(p.first_name)},</p>` +
      `<p style="color:#a00"><b>URGENT: your loan <code>${sid}</code> is at margin call.</b> Coverage is <b>${coverage}</b> — only ${marginToLiquidationCopy(p.coverage_percent)} away from auto-liquidation at 110%.</p>` +
      `<table style="font-family:system-ui,sans-serif;font-size:14px">` +
        row('Coverage',    coverage) +
        row('Outstanding', outstanding) +
        row('Collateral',  sats) +
      `</table>` +
      `<p><b>Act immediately.</b> Two options:</p>` +
      `<ol>` +
        `<li><b>Top up collateral.</b> Use the "Add collateral" flow to send more BTC.</li>` +
        `<li><b>Repay (in part or in full).</b> Pay any amount to your repayment account:</li>` +
      `</ol>` +
      paymentBlockHtml(p.repayment_account) +
      `<p style="color:#a00">If coverage drops to 110%, the loan auto-liquidates — no further notice. ` +
      `If BTC moves quickly, liquidation can happen in minutes.</p>` +
      FOOTER_HTML,
  };
}

// Tiny copy helper: phrases the gap between current coverage % and the 110%
// liquidation line in plain words ("3 percentage points"). Not exact math —
// the percent string can be a decimal — but the rounded gap is what the
// customer needs to feel the urgency without false precision.
function marginToLiquidationCopy(coverage_percent: string): string {
  const cov = parseFloat(coverage_percent);
  if (!Number.isFinite(cov)) return 'a few percentage points';
  const gap = cov - 110;
  if (gap <= 0) return 'at the liquidation line';
  if (gap < 1) return 'less than 1 percentage point';
  return `${Math.round(gap)} percentage point${Math.round(gap) === 1 ? '' : 's'}`;
}

// ── shared row renderer ──────────────────────────────────────────────────────

function row(label: string, value: string): string {
  return `<tr><td style="padding:4px 12px 4px 0;color:#666"><b>${escapeHtml(label)}</b></td><td style="padding:4px 0">${escapeHtml(value)}</td></tr>`;
}
