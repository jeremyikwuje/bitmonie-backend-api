/**
 * Loan Reminder Worker — standalone Node.js process (NOT NestJS).
 *
 * Sends customer emails reminding them of upcoming loan maturity, the day-of
 * maturity, daily through the 7-day grace period, and a final pre-liquidation
 * notice. Each (loan_id, slot) pair fires at most once — Redis key
 * `reminder_sent:{loan_id}:{slot}` deduplicates across ticks and worker restarts.
 *
 * See docs/repayment-matching-redesign.md §8.
 *
 * Run with: ts-node -r tsconfig-paths/register workers/loan-reminder.worker.ts
 */

import { PrismaClient, LoanStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import Redis from 'ioredis';
import Decimal from 'decimal.js';
import { REDIS_KEYS, LOAN_GRACE_PERIOD_DAYS } from '@/common/constants';
import { AccrualService } from '@/modules/loans/accrual.service';
import {
  buildReminderEmail,
  determineCurrentSlot,
  type ReminderSlot,
} from '@/modules/loans/reminder-templates';
import { MailgunProvider } from '@/providers/mailgun/mailgun.provider';
import { ResendProvider } from '@/providers/resend/resend.provider';
import { PostmarkProvider } from '@/providers/postmark/postmark.provider';
import type { EmailProvider, TransactionalEmailParams } from '@/modules/auth/email.provider.interface';
import { EMAIL_PROVIDER_CONFIG, EmailProviderName } from '@/config/email.config';

const WORKER_INTERVAL_MS = parseInt(process.env.WORKER_LOAN_REMINDER_INTERVAL_MS ?? '3600000', 10);

// 90 days — comfortably outpaces any (loan duration + grace + grace_final) combo.
const REMINDER_DEDUP_TTL_SEC = 90 * 86_400;

// Look-ahead and look-behind window for candidate loans relative to due_at.
// Pre-maturity reminders start 7d before due_at; grace_final fires 7d after.
// 8d on each side is a small buffer.
const CANDIDATE_WINDOW_MS = 8 * 86_400 * 1000;

export type SendEmail = (params: TransactionalEmailParams) => Promise<void>;

export interface LoanReminderDeps {
  prisma: PrismaClient;
  redis:  Redis;
  send_email: SendEmail;
  log: (level: string, event: string, extra?: Record<string, unknown>) => void;
  now?: () => Date;     // injectable clock for tests
}

function defaultLog(level: string, event: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(
    JSON.stringify({ level, worker: 'loan_reminder', event, time: new Date().toISOString(), ...extra }) + '\n',
  );
}

// Type for the projected loan rows we operate on. Kept narrow on purpose —
// Prisma's `Loan` type pulls in 28 columns we don't need here.
type CandidateLoan = {
  id:                       string;
  user_id:                  string;
  due_at:                   Date;
  principal_ngn:            Decimal | { toString(): string };
  daily_interest_rate_bps:  number;
  daily_custody_fee_ngn:    Decimal | { toString(): string };
  collateral_received_at:   Date | null;
  user: { email: string; first_name: string | null };
  repayment_account:        { virtual_account_no: string; virtual_account_name: string; bank_name: string } | null;
  repayments: Array<{
    applied_to_principal: Decimal | { toString(): string };
    applied_to_interest:  Decimal | { toString(): string };
    applied_to_custody:   Decimal | { toString(): string };
    created_at:           Date;
  }>;
};

export async function runReminderCycle(deps: LoanReminderDeps): Promise<void> {
  const { prisma, redis, send_email, log } = deps;
  const now = (deps.now ?? (() => new Date()))();

  const window_start = new Date(now.getTime() - CANDIDATE_WINDOW_MS);
  const window_end   = new Date(now.getTime() + CANDIDATE_WINDOW_MS);

  const candidates = (await prisma.loan.findMany({
    where: {
      status: LoanStatus.ACTIVE,
      due_at: { gte: window_start, lte: window_end },
    },
    include: {
      user:              { select: { email: true, first_name: true } },
      repayments:        true,
    },
  })) as unknown as CandidateLoan[];

  if (candidates.length === 0) {
    await redis.set(REDIS_KEYS.WORKER_HEARTBEAT('loan_reminder'), Date.now().toString());
    return;
  }

  // Batch-fetch repayment accounts for all unique users in one query.
  const user_ids = Array.from(new Set(candidates.map((l) => l.user_id)));
  const accounts = await prisma.userRepaymentAccount.findMany({
    where: { user_id: { in: user_ids } },
    select: { user_id: true, virtual_account_no: true, virtual_account_name: true, bank_name: true },
  });
  const account_by_user = new Map(accounts.map((a) => [a.user_id, a]));

  const accrual = new AccrualService();
  let sent = 0;
  let skipped_already_sent = 0;
  let skipped_no_account = 0;

  for (const loan of candidates) {
    try {
      const slot = determineCurrentSlot(loan.due_at, now);
      if (!slot) continue;

      const dedup_key = REDIS_KEYS.REMINDER_SENT(loan.id, slot);
      const already_sent = await redis.get(dedup_key);
      if (already_sent) {
        skipped_already_sent++;
        continue;
      }

      const account = account_by_user.get(loan.user_id) ?? loan.repayment_account ?? null;
      if (!account) {
        skipped_no_account++;
        log('warn', 'reminder_skipped_no_va', { loan_id: loan.id, user_id: loan.user_id, slot });
        continue;
      }

      const outstanding = accrual.compute({
        loan: {
          principal_ngn:           toDecimal(loan.principal_ngn),
          daily_interest_rate_bps: loan.daily_interest_rate_bps,
          daily_custody_fee_ngn:   toDecimal(loan.daily_custody_fee_ngn),
          collateral_received_at:  loan.collateral_received_at,
        },
        repayments: loan.repayments.map((r) => ({
          applied_to_principal: toDecimal(r.applied_to_principal),
          applied_to_interest:  toDecimal(r.applied_to_interest),
          applied_to_custody:   toDecimal(r.applied_to_custody),
          created_at:           r.created_at,
        })),
        as_of: now,
      });

      const email = buildReminderEmail(slot, {
        first_name:           loan.user.first_name,
        loan_id:              loan.id,
        outstanding_ngn:      outstanding.total_outstanding_ngn.toFixed(2),
        virtual_account_no:   account.virtual_account_no,
        virtual_account_name: account.virtual_account_name,
        bank_name:            account.bank_name,
        due_at:               loan.due_at,
      });

      await send_email({
        to:        loan.user.email,
        subject:   email.subject,
        text_body: email.text_body,
        html_body: email.html_body,
      });

      await redis.set(dedup_key, '1', 'EX', REMINDER_DEDUP_TTL_SEC);
      sent++;
      log('info', 'reminder_sent', { loan_id: loan.id, user_id: loan.user_id, slot });
    } catch (err) {
      log('error', 'reminder_failed', {
        loan_id: loan.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await redis.set(REDIS_KEYS.WORKER_HEARTBEAT('loan_reminder'), Date.now().toString());

  if (sent > 0 || skipped_already_sent > 0 || skipped_no_account > 0) {
    log('info', 'cycle_complete', {
      candidates: candidates.length,
      sent,
      skipped_already_sent,
      skipped_no_account,
      grace_period_days: LOAN_GRACE_PERIOD_DAYS,
    });
  }
}

function toDecimal(v: { toString(): string }): Decimal {
  return new Decimal(v.toString());
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────

function buildEmailProvider(): EmailProvider {
  switch (EMAIL_PROVIDER_CONFIG) {
    case EmailProviderName.Mailgun:
      return new MailgunProvider({
        api_key:      process.env.MAILGUN_API_KEY      ?? '',
        domain:       process.env.MAILGUN_DOMAIN       ?? '',
        region:       (process.env.MAILGUN_REGION as 'us' | 'eu') ?? 'us',
        from_address: process.env.MAILGUN_FROM_ADDRESS ?? '',
        from_name:    process.env.MAILGUN_FROM_NAME    ?? 'Bitmonie',
      });
    case EmailProviderName.Resend:
      return new ResendProvider({
        api_key:      process.env.RESEND_API_KEY      ?? '',
        from_address: process.env.RESEND_FROM_ADDRESS ?? '',
        from_name:    process.env.RESEND_FROM_NAME    ?? 'Bitmonie',
      });
    case EmailProviderName.Postmark:
      return new PostmarkProvider({
        server_token:   process.env.POSTMARK_SERVER_TOKEN  ?? '',
        from_address:   process.env.POSTMARK_FROM_ADDRESS  ?? '',
        from_name:      process.env.POSTMARK_FROM_NAME     ?? 'Bitmonie',
        message_stream: process.env.POSTMARK_MESSAGE_STREAM,
      });
  }
}

async function main(): Promise<void> {
  const DATABASE_URL = process.env.DATABASE_URL;
  const REDIS_URL    = process.env.REDIS_URL;
  if (!DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
  if (!REDIS_URL)    { console.error('REDIS_URL is required');    process.exit(1); }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });
  const redis = new Redis(REDIS_URL);
  redis.on('error', (err) => defaultLog('error', 'redis_error', { error: err.message }));

  const provider = buildEmailProvider();
  const send_email: SendEmail = (params) => provider.sendTransactional(params);

  const deps: LoanReminderDeps = { prisma, redis, send_email, log: defaultLog };

  defaultLog('info', 'started', { interval_ms: WORKER_INTERVAL_MS, email_provider: EMAIL_PROVIDER_CONFIG });
  await redis.ping();
  await runReminderCycle(deps);

  setInterval(() => {
    runReminderCycle(deps).catch((err) =>
      defaultLog('error', 'unhandled_error', { error: String(err) }),
    );
  }, WORKER_INTERVAL_MS);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Worker failed to start:', err);
    process.exit(1);
  });
}
