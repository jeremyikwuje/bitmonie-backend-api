/**
 * Liquidation Monitor Worker — standalone Node.js process (NOT NestJS).
 * Checks all ACTIVE loans against current SAT/NGN rate every 30s.
 * Alerts at 120% LTV, liquidates at 110% LTV.
 * Run with: ts-node -r tsconfig-paths/register workers/liquidation-monitor.worker.ts
 */

import { PrismaClient, LoanStatus, StatusTrigger } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import Redis from 'ioredis';
import Decimal from 'decimal.js';
import {
  LIQUIDATION_THRESHOLD,
  ALERT_THRESHOLD,
  ALERT_COOLDOWN_SEC,
  MIN_LIQUIDATION_RATE_FRACTION,
  REDIS_KEYS,
  LoanReasonCodes,
} from '@/common/constants';
import { AccrualService } from '@/modules/loans/accrual.service';
import { BlinkProvider } from '@/providers/blink/blink.provider';

const WORKER_INTERVAL_MS = parseInt(process.env.WORKER_LIQUIDATION_INTERVAL_MS ?? '30000', 10);
const INTERNAL_ALERT_EMAIL = process.env.INTERNAL_ALERT_EMAIL ?? 'ops@bitmonie.com';

export interface LiquidationDeps {
  prisma: PrismaClient;
  redis: Redis;
  log: (level: string, event: string, extra?: Record<string, unknown>) => void;
  blink: { swapBtcToUsd: (amount_sat: bigint) => Promise<void> };
  accrual: AccrualService;
}

function defaultLog(level: string, event: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(
    JSON.stringify({ level, worker: 'liquidation_monitor', event, time: new Date().toISOString(), ...extra }) + '\n',
  );
}

export async function runLiquidationCycle(deps: LiquidationDeps): Promise<void> {
  const { prisma, redis, log, blink, accrual } = deps;

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
    } else if (ratio.lte(ALERT_THRESHOLD)) {
      // Alert — check cooldown
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

  if (active_loans.length > 0 || liquidated > 0 || alerted > 0 || suspicious_skipped > 0) {
    log('info', 'cycle_complete', {
      checked: active_loans.length,
      liquidated,
      alerted,
      suspicious_skipped,
      rate: current_rate.toFixed(6),
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

  const deps: LiquidationDeps = { prisma, redis, log: defaultLog, blink, accrual };

  defaultLog('info', 'started', { interval_ms: WORKER_INTERVAL_MS });
  await redis.ping();
  await runLiquidationCycle(deps);

  setInterval(() => {
    runLiquidationCycle(deps).catch((err) =>
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
