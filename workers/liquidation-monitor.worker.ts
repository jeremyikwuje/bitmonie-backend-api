/**
 * Liquidation Monitor Worker — standalone Node.js process (NOT NestJS).
 *
 * Hosts two loan-monitoring cycles on independent intervals:
 *
 *   A. Liquidation sweep — every WORKER_LIQUIDATION_INTERVAL_MS (default 30s).
 *      Single sweep per tick over every ACTIVE loan, three responsibilities:
 *
 *        1. Liquidate at coverage ≤ 1.10 (LIQUIDATION_THRESHOLD).
 *        2. Customer-facing coverage nudges with recovery-aware Redis dedupe:
 *             coverage <  1.20 (COVERAGE_WARN_TIER)        → "your collateral is dropping"
 *             coverage <  1.15 (COVERAGE_MARGIN_CALL_TIER) → "MARGIN CALL — top up or repay now"
 *           Each tier's dedupe key is cleared the moment coverage rises back above
 *           that tier so a future re-deterioration re-fires once.
 *        3. Ops-internal alert at coverage ≤ 1.20 (ALERT_THRESHOLD), 24h dedupe.
 *
 *   B. Collateral-release cycle — every WORKER_COLLATERAL_RELEASE_INTERVAL_MS
 *      (default 5m). Safety net for `LoansService.creditInflow`'s post-commit
 *      release hand-off and for loans where the customer set their release
 *      address only after REPAID. Implementation in
 *      `workers/collateral-release.worker.ts`.
 *
 *      Folded in here (rather than as a fourth Railway service) because both
 *      cycles operate on the `loans` table, share Blink + Redis + email
 *      providers, and both touch money — so the same fault-isolation
 *      reasoning applies to both. See `railway/README.md`.
 *
 * Run with: ts-node -r tsconfig-paths/register workers/liquidation-monitor.worker.ts
 */

import {
  PrismaClient,
  LoanStatus,
  StatusTrigger,
} from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import Redis from 'ioredis';
import Decimal from 'decimal.js';
import {
  ALERT_COOLDOWN_SEC,
  ALERT_THRESHOLD,
  COVERAGE_MARGIN_CALL_TIER,
  COVERAGE_WARN_TIER,
  LIQUIDATION_THRESHOLD,
  LoanReasonCodes,
  MIN_LIQUIDATION_RATE_FRACTION,
  REDIS_KEYS,
} from '@/common/constants';
import { displayNgn } from '@/common/formatting/ngn-display';
import { ConfigService } from '@nestjs/config';
import { AccrualService } from '@/modules/loans/accrual.service';
import { CollateralReleaseService } from '@/modules/loans/collateral-release.service';
import { LoanStatusService } from '@/modules/loans/loan-status.service';
import { LoanNotificationsService } from '@/modules/loan-notifications/loan-notifications.service';
import { OpsAlertsService } from '@/modules/ops-alerts/ops-alerts.service';
import { BlinkProvider } from '@/providers/blink/blink.provider';
import { MailgunProvider } from '@/providers/mailgun/mailgun.provider';
import { ResendProvider } from '@/providers/resend/resend.provider';
import { PostmarkProvider } from '@/providers/postmark/postmark.provider';
import type { EmailProvider } from '@/modules/auth/email.provider.interface';
import type { PrismaService } from '@/database/prisma.service';
import { EMAIL_PROVIDER_CONFIG, EmailProviderName } from '@/config/email.config';
import {
  buildCoverageWarnEmail,
  buildMarginCallEmail,
  type RepaymentAccountSummary,
} from '@/modules/loan-notifications/loan-notification-templates';
import {
  runCollateralReleaseCycle,
  type CollateralReleaseWorkerDeps,
} from './collateral-release.worker';

const WORKER_INTERVAL_MS = parseInt(process.env.WORKER_LIQUIDATION_INTERVAL_MS ?? '30000', 10);
const COLLATERAL_RELEASE_INTERVAL_MS = parseInt(
  process.env.WORKER_COLLATERAL_RELEASE_INTERVAL_MS ?? '300000',  // 5 min default
  10,
);
const INTERNAL_ALERT_EMAIL = process.env.INTERNAL_ALERT_EMAIL ?? 'ops@bitmonie.com';

export interface LiquidationDeps {
  prisma: PrismaClient;
  redis: Redis;
  log: (level: string, event: string, extra?: Record<string, unknown>) => void;
  blink: { swapBtcToUsd: (amount_sat: bigint) => Promise<void> };
  accrual: AccrualService;
  // Customer-nudge email send. Optional in tests so unit tests don't need
  // to wire up an email provider — passing undefined just suppresses the email.
  send_email?: (params: { to: string; subject: string; text_body: string; html_body: string }) => Promise<void>;
}

function defaultLog(level: string, event: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(
    JSON.stringify({ level, worker: 'liquidation_monitor', event, time: new Date().toISOString(), ...extra }) + '\n',
  );
}

export async function runLiquidationCycle(deps: LiquidationDeps): Promise<void> {
  const { prisma, redis, log, blink, accrual, send_email } = deps;

  // 1. Skip if price is stale
  const stale = await redis.get(REDIS_KEYS.PRICE_STALE);
  if (stale) {
    log('warn', 'price_stale_skip', { message: 'Price feed is stale — skipping liquidation cycle' });
    await redis.set(REDIS_KEYS.WORKER_HEARTBEAT('liquidation_monitor'), Date.now().toString());
    return;
  }

  // 2. Fetch current SAT/NGN sell rate from Redis
  const rate_raw = await redis.get(REDIS_KEYS.PRICE('SAT_NGN'));
  if (!rate_raw) {
    log('warn', 'no_rate', { message: 'SAT_NGN rate not in Redis — skipping cycle' });
    await redis.set(REDIS_KEYS.WORKER_HEARTBEAT('liquidation_monitor'), Date.now().toString());
    return;
  }

  let current_rate: Decimal;
  try {
    const parsed = JSON.parse(rate_raw) as { sell: string };
    current_rate = new Decimal(parsed.sell);
  } catch {
    log('error', 'rate_parse_error', { raw: rate_raw });
    await redis.set(REDIS_KEYS.WORKER_HEARTBEAT('liquidation_monitor'), Date.now().toString());
    return;
  }

  // 2a. Hard guard: a non-positive rate is always a broken feed. Mark stale,
  // page ops, and abort the cycle — never liquidate on a zero/negative price.
  if (!current_rate.isFinite() || current_rate.lte(0)) {
    log('error', 'rate_non_positive_abort', {
      raw: rate_raw,
      alert_recipient: INTERNAL_ALERT_EMAIL,
    });
    await redis.set(REDIS_KEYS.PRICE_STALE, Date.now().toString());
    await redis.set(REDIS_KEYS.WORKER_HEARTBEAT('liquidation_monitor'), Date.now().toString());
    return;
  }

  // 3. Query ACTIVE loans FOR UPDATE SKIP LOCKED
  type ActiveLoanRow = {
    id: string;
    user_id: string;
    collateral_amount_sat: bigint;
    principal_ngn: string;
    daily_interest_rate_bps: number;
    daily_custody_fee_ngn: string;
    collateral_received_at: Date | null;
    sat_ngn_rate_at_creation: string;
    collateral_release_address: string | null;
  };

  const active_loans = await prisma.$queryRaw<ActiveLoanRow[]>`
    SELECT id, user_id, collateral_amount_sat,
           principal_ngn::text,
           daily_interest_rate_bps,
           daily_custody_fee_ngn::text,
           collateral_received_at,
           sat_ngn_rate_at_creation::text,
           collateral_release_address
    FROM loans
    WHERE status = ${LoanStatus.ACTIVE}::"LoanStatus"
    FOR UPDATE SKIP LOCKED
  `;

  // 3a. Pull repayments for all locked loans in one query — needed for accrual
  // (the waterfall reduces principal piecewise, which changes the daily
  // interest rate from each repayment forward).
  const repayments_by_loan = new Map<string, Array<{
    applied_to_principal: Decimal;
    applied_to_interest:  Decimal;
    applied_to_custody:   Decimal;
    created_at:           Date;
  }>>();

  if (active_loans.length > 0) {
    const repayment_rows = await prisma.loanRepayment.findMany({
      where: { loan_id: { in: active_loans.map((l) => l.id) } },
      select: {
        loan_id:              true,
        applied_to_principal: true,
        applied_to_interest:  true,
        applied_to_custody:   true,
        created_at:           true,
      },
    });
    for (const row of repayment_rows) {
      const list = repayments_by_loan.get(row.loan_id) ?? [];
      list.push({
        applied_to_principal: new Decimal(row.applied_to_principal.toString()),
        applied_to_interest:  new Decimal(row.applied_to_interest.toString()),
        applied_to_custody:   new Decimal(row.applied_to_custody.toString()),
        created_at:           row.created_at,
      });
      repayments_by_loan.set(row.loan_id, list);
    }
  }

  let liquidated = 0;
  let alerted = 0;
  let warn_sent = 0;
  let margin_call_sent = 0;
  let suspicious_skipped = 0;
  const as_of = new Date();

  for (const loan of active_loans) {
    const collateral_sat = new Decimal(loan.collateral_amount_sat.toString());
    const principal = new Decimal(loan.principal_ngn);
    const rate_at_creation = new Decimal(loan.sat_ngn_rate_at_creation);

    // Compute live outstanding (principal + accrued interest + accrued custody)
    // per CLAUDE.md §5.4a. Liquidation ratio is collateral / outstanding,
    // NOT collateral / principal.
    const outstanding = accrual.compute({
      loan: {
        principal_ngn:           principal,
        daily_interest_rate_bps: loan.daily_interest_rate_bps,
        daily_custody_fee_ngn:   new Decimal(loan.daily_custody_fee_ngn),
        collateral_received_at:  loan.collateral_received_at,
      },
      repayments: repayments_by_loan.get(loan.id) ?? [],
      as_of,
    });

    const current_value_ngn = collateral_sat.mul(current_rate);
    const ratio = current_value_ngn.div(outstanding.total_outstanding_ngn);

    // Per-loan sanity bound: never liquidate if the current rate has cratered
    // beyond a plausible market move vs. this loan's origination rate. Page ops
    // — if the drop is real, ops can verify and liquidate manually; if it's a
    // single-feed glitch, this stops it from cascading across the book.
    const sanity_floor = rate_at_creation.mul(MIN_LIQUIDATION_RATE_FRACTION);
    if (current_rate.lt(sanity_floor)) {
      suspicious_skipped++;
      log('error', 'liquidation_skipped_rate_suspect', {
        loan_id:                  loan.id,
        user_id:                  loan.user_id,
        current_rate:             current_rate.toFixed(6),
        rate_at_creation:         rate_at_creation.toFixed(6),
        sanity_floor:             sanity_floor.toFixed(6),
        min_fraction:             MIN_LIQUIDATION_RATE_FRACTION.toString(),
        ratio:                    ratio.toFixed(4),
        alert_recipient:          INTERNAL_ALERT_EMAIL,
      });
      continue;
    }

    if (ratio.lte(LIQUIDATION_THRESHOLD)) {
      // Liquidate
      try {
        await liquidateLoan(prisma, loan, current_rate, log);
        liquidated++;
        // Swap seized collateral to USD stable-sats to protect against further BTC decline.
        // Runs after the DB transaction commits — swap failure is logged but does not
        // un-liquidate the loan.
        try {
          await blink.swapBtcToUsd(loan.collateral_amount_sat);
          log('info', 'btc_swapped_to_usd', {
            loan_id:    loan.id,
            amount_sat: loan.collateral_amount_sat.toString(),
          });
        } catch (swap_err) {
          log('error', 'btc_swap_failed', {
            loan_id: loan.id,
            error: swap_err instanceof Error ? swap_err.message : String(swap_err),
          });
        }
      } catch (err) {
        log('error', 'liquidation_failed', {
          loan_id: loan.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    // ── Customer-tier nudges (recovery-aware Redis dedupe) ──────────────────
    try {
      const result = await evaluateCoverageTiers({
        prisma,
        redis,
        log,
        send_email,
        loan,
        ratio,
        outstanding_ngn: outstanding.total_outstanding_ngn,
      });
      warn_sent += result.warn_sent ? 1 : 0;
      margin_call_sent += result.margin_call_sent ? 1 : 0;
    } catch (err) {
      log('error', 'coverage_nudge_failed', {
        loan_id: loan.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // ── Ops-internal alert at coverage ≤ ALERT_THRESHOLD (24h dedupe) ───────
    if (ratio.lte(ALERT_THRESHOLD)) {
      const alert_key = REDIS_KEYS.ALERT_SENT(loan.id);
      const already_alerted = await redis.get(alert_key);
      if (!already_alerted) {
        await redis.set(alert_key, '1', 'EX', ALERT_COOLDOWN_SEC);
        log('warn', 'liquidation_alert', {
          loan_id:           loan.id,
          user_id:           loan.user_id,
          ratio:             ratio.toFixed(4),
          current_value_ngn: current_value_ngn.toFixed(2),
          outstanding_ngn:   outstanding.total_outstanding_ngn.toFixed(2),
          principal_ngn:     principal.toFixed(2),
          alert_recipient:   INTERNAL_ALERT_EMAIL,
        });
        alerted++;
      }
    }
  }

  await redis.set(REDIS_KEYS.WORKER_HEARTBEAT('liquidation_monitor'), Date.now().toString());

  if (active_loans.length > 0 || liquidated > 0 || alerted > 0 || suspicious_skipped > 0 || warn_sent > 0 || margin_call_sent > 0) {
    log('info', 'cycle_complete', {
      checked: active_loans.length,
      liquidated,
      alerted,
      warn_sent,
      margin_call_sent,
      suspicious_skipped,
      rate: current_rate.toFixed(6),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Coverage-tier evaluation (recovery-aware dedupe)
//
// `ratio` is collateral_ngn / total_outstanding_ngn. Higher = healthier.
// Caller has already established `ratio > LIQUIDATION_THRESHOLD` — this
// function only handles the WARN and MARGIN_CALL tiers + recovery clears.
// ─────────────────────────────────────────────────────────────────────────────
async function evaluateCoverageTiers(params: {
  prisma: PrismaClient;
  redis: Redis;
  log: LiquidationDeps['log'];
  send_email: LiquidationDeps['send_email'];
  loan: { id: string; user_id: string; collateral_amount_sat: bigint };
  ratio: Decimal;
  outstanding_ngn: Decimal;
}): Promise<{ warn_sent: boolean; margin_call_sent: boolean }> {
  const { prisma, redis, log, send_email, loan, ratio, outstanding_ngn } = params;
  const warn_key = REDIS_KEYS.COVERAGE_WARN_NOTIFIED(loan.id);
  const mc_key   = REDIS_KEYS.COVERAGE_MARGIN_CALL_NOTIFIED(loan.id);

  // Healthy: clear both keys (recovery from any prior tier).
  if (ratio.gte(COVERAGE_WARN_TIER)) {
    await redis.del(warn_key, mc_key);
    return { warn_sent: false, margin_call_sent: false };
  }

  // Below WARN tier — fire WARN once across BTC drawdowns and recoveries.
  // SETNX returns 'OK' on first set, null when key already exists.
  let warn_sent = false;
  const warn_first = await redis.set(warn_key, '1', 'NX');
  if (warn_first === 'OK') {
    await sendCoverageNotice({
      prisma, log, send_email,
      loan, ratio, outstanding_ngn, kind: 'warn',
    });
    warn_sent = true;
  }

  // Above MARGIN_CALL tier (between 1.15 and 1.20): clear MARGIN_CALL recovery.
  if (ratio.gte(COVERAGE_MARGIN_CALL_TIER)) {
    await redis.del(mc_key);
    return { warn_sent, margin_call_sent: false };
  }

  // Below MARGIN_CALL tier — fire MARGIN_CALL once.
  let margin_call_sent = false;
  const mc_first = await redis.set(mc_key, '1', 'NX');
  if (mc_first === 'OK') {
    await sendCoverageNotice({
      prisma, log, send_email,
      loan, ratio, outstanding_ngn, kind: 'margin_call',
    });
    margin_call_sent = true;
  }

  return { warn_sent, margin_call_sent };
}

// Loads user + repayment-account, renders the appropriate template, and
// dispatches via the worker's email provider. Best-effort — a missing user,
// missing VA, or provider failure is logged but doesn't throw (the dedupe
// key is already set, so we won't retry until coverage recovers and re-drops).
async function sendCoverageNotice(params: {
  prisma: PrismaClient;
  log: LiquidationDeps['log'];
  send_email: LiquidationDeps['send_email'];
  loan: { id: string; user_id: string; collateral_amount_sat: bigint };
  ratio: Decimal;
  outstanding_ngn: Decimal;
  kind: 'warn' | 'margin_call';
}): Promise<void> {
  const { prisma, log, send_email, loan, ratio, outstanding_ngn, kind } = params;
  if (!send_email) {
    // Test path — dedupe still works, no email sent.
    return;
  }

  const [user, va] = await Promise.all([
    prisma.user.findUnique({
      where:  { id: loan.user_id },
      select: { email: true, first_name: true },
    }),
    prisma.userRepaymentAccount.findUnique({
      where:  { user_id: loan.user_id },
      select: { virtual_account_no: true, virtual_account_name: true, bank_name: true },
    }),
  ]);

  if (!user) {
    log('warn', 'coverage_nudge_skipped_no_user', { loan_id: loan.id, kind });
    return;
  }
  if (!va) {
    log('warn', 'coverage_nudge_skipped_no_va', { loan_id: loan.id, user_id: loan.user_id, kind });
    return;
  }

  // Coverage as a percent string with 0 decimals — "118" / "112". Customer
  // doesn't need 4-decimal precision; the round figure communicates the
  // urgency cleanly.
  const coverage_percent = ratio.mul(100).toFixed(0);

  const repayment_account: RepaymentAccountSummary = {
    virtual_account_no:   va.virtual_account_no,
    virtual_account_name: va.virtual_account_name,
    bank_name:            va.bank_name,
  };

  const email = kind === 'warn'
    ? buildCoverageWarnEmail({
        first_name:            user.first_name,
        loan_id:               loan.id,
        coverage_percent,
        outstanding_ngn:       displayNgn(outstanding_ngn, 'ceil'),
        collateral_amount_sat: loan.collateral_amount_sat,
        repayment_account,
      })
    : buildMarginCallEmail({
        first_name:            user.first_name,
        loan_id:               loan.id,
        coverage_percent,
        outstanding_ngn:       displayNgn(outstanding_ngn, 'ceil'),
        collateral_amount_sat: loan.collateral_amount_sat,
        repayment_account,
      });

  try {
    await send_email({
      to:        user.email,
      subject:   email.subject,
      text_body: email.text_body,
      html_body: email.html_body,
    });
    log('info', 'coverage_nudge_sent', {
      loan_id:          loan.id,
      user_id:          loan.user_id,
      kind,
      coverage_percent,
    });
  } catch (err) {
    log('error', 'coverage_nudge_send_failed', {
      loan_id: loan.id,
      kind,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function liquidateLoan(
  prisma: PrismaClient,
  loan: { id: string; user_id: string; collateral_amount_sat: bigint; collateral_release_address: string | null },
  current_rate: Decimal,
  log: LiquidationDeps['log'],
): Promise<void> {
  await (prisma as PrismaClient).$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.loan.update({
      where: { id: loan.id },
      data: {
        status: LoanStatus.LIQUIDATED,
        liquidated_at: new Date(),
        liquidation_rate_actual: current_rate,
      },
    });

    await tx.loanStatusLog.create({
      data: {
        loan_id:      loan.id,
        user_id:      loan.user_id,
        from_status:  LoanStatus.ACTIVE,
        to_status:    LoanStatus.LIQUIDATED,
        triggered_by: StatusTrigger.SYSTEM,
        reason_code:  LoanReasonCodes.LIQUIDATION_COMPLETED,
      },
    });
  });

  log('warn', 'loan_liquidated', {
    loan_id: loan.id,
    user_id: loan.user_id,
    current_rate: current_rate.toFixed(6),
  });
}

function buildEmailProvider(): EmailProvider {
  switch (EMAIL_PROVIDER_CONFIG) {
    case EmailProviderName.Mailgun:
      return new MailgunProvider({
        api_key:      process.env.MAILGUN_API_KEY      ?? '',
        domain:       process.env.MAILGUN_DOMAIN       ?? '',
        region:       (process.env.MAILGUN_REGION as 'us' | 'eu') ?? 'us',
        from_address: process.env.EMAIL_FROM_ADDRESS ?? '',
        from_name:    process.env.EMAIL_FROM_NAME    ?? 'Bitmonie',
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

// Minimal stand-in for `ConfigService` used by `OpsAlertsService`. The worker
// runs outside the Nest DI container, so we hand the service the one config
// key it actually reads (`internal_alert_email`).
class WorkerConfigService {
  get<T>(): T {
    return { internal_alert_email: process.env.INTERNAL_ALERT_EMAIL ?? null } as unknown as T;
  }
}

function buildCollateralReleaseDeps(
  prisma: PrismaClient,
  redis: Redis,
  blink: BlinkProvider,
  email_provider: EmailProvider,
): CollateralReleaseWorkerDeps {
  // PrismaClient → PrismaService cast is safe (the service just extends the
  // client). Same shape across all workers.
  const prisma_as_service = prisma as unknown as PrismaService;
  const ops_alerts = new OpsAlertsService(
    email_provider,
    new WorkerConfigService() as unknown as ConfigService,
  );
  const loan_status = new LoanStatusService();
  const loan_notifications = new LoanNotificationsService(email_provider, prisma_as_service);
  const collateral_release = new CollateralReleaseService(
    prisma_as_service,
    blink,
    loan_status,
    ops_alerts,
    redis,
    loan_notifications,
  );

  const log = (level: string, event: string, extra: Record<string, unknown> = {}): void => {
    process.stdout.write(
      JSON.stringify({
        level,
        worker: 'collateral_release',
        event,
        time: new Date().toISOString(),
        ...extra,
      }) + '\n',
    );
  };

  return { prisma, redis, collateral_release, log };
}

async function main(): Promise<void> {
  const DATABASE_URL = process.env.DATABASE_URL;
  const REDIS_URL    = process.env.REDIS_URL;
  if (!DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
  if (!REDIS_URL)    { console.error('REDIS_URL is required');    process.exit(1); }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });
  const redis  = new Redis(REDIS_URL);
  redis.on('error', (err) => defaultLog('error', 'redis_error', { error: err.message }));

  const blink = new BlinkProvider({
    api_key:        process.env.BLINK_API_KEY        ?? '',
    base_url:       process.env.BLINK_BASE_URL        ?? 'https://api.blink.sv',
    wallet_btc_id:  process.env.BLINK_WALLET_BTC_ID   ?? '',
    wallet_usd_id:  process.env.BLINK_WALLET_USD_ID   ?? '',
    account_id:     process.env.BLINK_ACCOUNT_ID      ?? '',
    webhook_secret: process.env.BLINK_WEBHOOK_SECRET  ?? '',
  });

  const accrual = new AccrualService();
  const email_provider = buildEmailProvider();
  const send_email: LiquidationDeps['send_email'] = (params) =>
    email_provider.sendTransactional(params);

  const liquidation_deps: LiquidationDeps = { prisma, redis, log: defaultLog, blink, accrual, send_email };
  const release_deps = buildCollateralReleaseDeps(prisma, redis, blink, email_provider);

  defaultLog('info', 'started', {
    liquidation_interval_ms:         WORKER_INTERVAL_MS,
    collateral_release_interval_ms:  COLLATERAL_RELEASE_INTERVAL_MS,
    email_provider:                  EMAIL_PROVIDER_CONFIG,
  });
  await redis.ping();

  // Kick both cycles once at boot so we don't wait a full interval before the
  // first sweep — same pattern as the price-feed worker.
  await runLiquidationCycle(liquidation_deps);
  await runCollateralReleaseCycle(release_deps).catch((err) =>
    defaultLog('error', 'collateral_release_unhandled_error', { error: String(err) }),
  );

  setInterval(() => {
    runLiquidationCycle(liquidation_deps).catch((err) =>
      defaultLog('error', 'unhandled_error', { error: String(err) }),
    );
  }, WORKER_INTERVAL_MS);

  setInterval(() => {
    runCollateralReleaseCycle(release_deps).catch((err) =>
      defaultLog('error', 'collateral_release_unhandled_error', { error: String(err) }),
    );
  }, COLLATERAL_RELEASE_INTERVAL_MS);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Worker failed to start:', err);
    process.exit(1);
  });
}
