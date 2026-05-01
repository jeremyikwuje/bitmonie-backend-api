// ─────────────────────────────────────────────────────────────────────────────
// Loan reminder templates — pure functions, no DB / no NestJS deps.
// Used by workers/loan-reminder.worker.ts (a standalone Node process).
// See docs/repayment-matching-redesign.md §8.
// ─────────────────────────────────────────────────────────────────────────────

export type ReminderSlot =
  | 't_minus_7d'
  | 't_minus_1d'
  | 't_maturity'
  | 'grace_d1'
  | 'grace_d2'
  | 'grace_d3'
  | 'grace_d4'
  | 'grace_d5'
  | 'grace_d6'
  | 'grace_final';

// Slot definitions — `offset_hours` is hours from `due_at`. Negative = before
// maturity. `grace_final` fires on T+7d, the last day before forced liquidation.
export const REMINDER_SLOTS: ReadonlyArray<{ slot: ReminderSlot; offset_hours: number }> = [
  { slot: 't_minus_7d',  offset_hours: -168 },
  { slot: 't_minus_1d',  offset_hours: -24  },
  { slot: 't_maturity',  offset_hours: 0    },
  { slot: 'grace_d1',    offset_hours: 24   },
  { slot: 'grace_d2',    offset_hours: 48   },
  { slot: 'grace_d3',    offset_hours: 72   },
  { slot: 'grace_d4',    offset_hours: 96   },
  { slot: 'grace_d5',    offset_hours: 120  },
  { slot: 'grace_d6',    offset_hours: 144  },
  { slot: 'grace_final', offset_hours: 168  },
];

// Returns the LATEST slot whose target send time is <= now. Missed slots are
// not backfilled — if the worker is down, only the most recent slot fires.
// Returns null when the loan is more than 7 days from maturity (nothing to send).
export function determineCurrentSlot(due_at: Date, now: Date): ReminderSlot | null {
  const hours_from_due = (now.getTime() - due_at.getTime()) / 3_600_000;
  let current: ReminderSlot | null = null;
  for (const { slot, offset_hours } of REMINDER_SLOTS) {
    if (hours_from_due >= offset_hours) {
      current = slot;
    } else {
      break;
    }
  }
  return current;
}

export interface ReminderTemplateParams {
  first_name:           string | null;
  loan_id:              string;
  outstanding_ngn:      string;     // pre-formatted with 2dp
  virtual_account_no:   string;
  virtual_account_name: string;
  bank_name:            string;     // partner bank visible to the customer on their transfer screen
  due_at:               Date;
}

export interface ReminderEmail {
  subject:   string;
  text_body: string;
  html_body: string;
}

const NGN = (amount: string) => `₦${formatThousands(amount)}`;

function formatThousands(amount: string): string {
  const [whole, frac = '00'] = amount.split('.');
  const grouped = (whole ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${grouped}.${frac}`;
}

function shortLoanId(loan_id: string): string {
  return loan_id.replace(/-/g, '').slice(0, 8).toUpperCase();
}

function greet(first_name: string | null): string {
  return first_name ? `Hi ${first_name}` : 'Hi';
}

function paymentBlock(p: ReminderTemplateParams): string {
  return `Pay to:\n  Bank:            ${p.bank_name}\n  Account name:    ${p.virtual_account_name}\n  Account number:  ${p.virtual_account_no}`;
}

function paymentBlockHtml(p: ReminderTemplateParams): string {
  // See loan-notification-templates.ts paymentBlockHtml — Gmail iOS strips
  // font-size on <code>, so use an explicitly-styled span for the account
  // number instead.
  return `<p style="margin:12px 0">Pay to:<br><b>${escapeHtml(p.bank_name)}</b><br><b>${escapeHtml(p.virtual_account_name)}</b><br><span style="font-size:20px;font-weight:700;letter-spacing:0.5px;font-family:Menlo,Consolas,monospace">${escapeHtml(p.virtual_account_no)}</span></p>`;
}

const FOOTER_TEXT = '\n\n— Bitmonie';
const FOOTER_HTML = '<p style="color:#666;font-size:12px;margin-top:20px">— Bitmonie</p>';

// ─────────────────────────────────────────────────────────────────────────────

export function buildReminderEmail(slot: ReminderSlot, p: ReminderTemplateParams): ReminderEmail {
  const sid = shortLoanId(p.loan_id);
  const greeting = greet(p.first_name);
  const owed = NGN(p.outstanding_ngn);

  switch (slot) {
    case 't_minus_7d':
      return {
        subject: `Your Bitmonie loan ${sid} is due in 7 days`,
        text_body:
          `${greeting},\n\nYour Bitmonie loan ${sid} matures in 7 days on ${p.due_at.toDateString()}.\n` +
          `You currently owe ${owed} (interest and custody fees accrue daily).\n\n` +
          `${paymentBlock(p)}${FOOTER_TEXT}`,
        html_body:
          `<p>${greeting},</p>` +
          `<p>Your Bitmonie loan <code>${sid}</code> matures in <b>7 days</b> on ${escapeHtml(p.due_at.toDateString())}.</p>` +
          `<p>You currently owe <b>${owed}</b> (interest and custody fees accrue daily).</p>` +
          `${paymentBlockHtml(p)}${FOOTER_HTML}`,
      };

    case 't_minus_1d':
      return {
        subject: `Your Bitmonie loan ${sid} is due tomorrow`,
        text_body:
          `${greeting},\n\nYour Bitmonie loan ${sid} matures TOMORROW (${p.due_at.toDateString()}).\n` +
          `You currently owe ${owed}.\n\n` +
          `${paymentBlock(p)}${FOOTER_TEXT}`,
        html_body:
          `<p>${greeting},</p>` +
          `<p>Your Bitmonie loan <code>${sid}</code> matures <b>tomorrow</b> (${escapeHtml(p.due_at.toDateString())}).</p>` +
          `<p>You currently owe <b>${owed}</b>.</p>` +
          `${paymentBlockHtml(p)}${FOOTER_HTML}`,
      };

    case 't_maturity':
      return {
        subject: `Your Bitmonie loan ${sid} is due TODAY`,
        text_body:
          `${greeting},\n\nYour Bitmonie loan ${sid} is due TODAY.\n` +
          `You owe ${owed}.\n\n` +
          `If you can't repay in full today, you can:\n` +
          `  - Make a partial repayment of at least ₦10,000\n` +
          `  - Add more BTC collateral to defend your loan\n\n` +
          `If your loan is not fully repaid within 7 days, your collateral will be liquidated.\n\n` +
          `${paymentBlock(p)}${FOOTER_TEXT}`,
        html_body:
          `<p>${greeting},</p>` +
          `<p>Your Bitmonie loan <code>${sid}</code> is due <b>TODAY</b>.</p>` +
          `<p>You owe <b>${owed}</b>.</p>` +
          `<p>If you can't repay in full today, you can:</p>` +
          `<ul><li>Make a partial repayment of at least ₦10,000</li><li>Add more BTC collateral to defend your loan</li></ul>` +
          `<p style="color:#a00">If your loan is not fully repaid within 7 days, your collateral will be liquidated.</p>` +
          `${paymentBlockHtml(p)}${FOOTER_HTML}`,
      };

    case 'grace_final':
      return {
        subject: `FINAL NOTICE: Bitmonie loan ${sid} will be liquidated soon`,
        text_body:
          `${greeting},\n\nFINAL NOTICE.\n\n` +
          `Your Bitmonie loan ${sid} is overdue and will be LIQUIDATED tomorrow if not repaid.\n` +
          `You owe ${owed}.\n\n` +
          `Pay immediately to avoid losing your collateral.\n\n` +
          `${paymentBlock(p)}${FOOTER_TEXT}`,
        html_body:
          `<p>${greeting},</p>` +
          `<p style="color:#a00;font-weight:bold;font-size:16px">FINAL NOTICE</p>` +
          `<p>Your Bitmonie loan <code>${sid}</code> is overdue and will be <b>LIQUIDATED tomorrow</b> if not repaid.</p>` +
          `<p>You owe <b>${owed}</b>.</p>` +
          `<p>Pay immediately to avoid losing your collateral.</p>` +
          `${paymentBlockHtml(p)}${FOOTER_HTML}`,
      };

    default: {
      // Generic grace_d1..d6 reminder
      const days_late = parseInt(slot.replace('grace_d', ''), 10);
      const days_left = 7 - days_late;
      return {
        subject: `Your Bitmonie loan ${sid} is ${days_late} day${days_late === 1 ? '' : 's'} overdue`,
        text_body:
          `${greeting},\n\nYour Bitmonie loan ${sid} was due ${days_late} day${days_late === 1 ? '' : 's'} ago and is now overdue.\n` +
          `You owe ${owed}.\n\n` +
          `You have ${days_left} day${days_left === 1 ? '' : 's'} left before liquidation.\n` +
          `You can repay (any amount ≥ ₦10,000) or add collateral.\n\n` +
          `${paymentBlock(p)}${FOOTER_TEXT}`,
        html_body:
          `<p>${greeting},</p>` +
          `<p>Your Bitmonie loan <code>${sid}</code> was due <b>${days_late} day${days_late === 1 ? '' : 's'} ago</b> and is now overdue.</p>` +
          `<p>You owe <b>${owed}</b>.</p>` +
          `<p>You have <b>${days_left} day${days_left === 1 ? '' : 's'}</b> left before liquidation. You can repay (any amount ≥ ₦10,000) or add collateral.</p>` +
          `${paymentBlockHtml(p)}${FOOTER_HTML}`,
      };
    }
  }
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
