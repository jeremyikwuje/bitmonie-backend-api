#!/usr/bin/env node
/**
 * Ops remediation: restore loans liquidated by the bug where the liquidation
 * monitor accepted a 0/near-zero SAT/NGN rate and stamped it onto the loan as
 * `liquidation_rate_actual`.
 *
 * Identification rule (same signature the ops REST endpoint enforces):
 *   status = LIQUIDATED
 *     AND liquidation_rate_actual IS NULL
 *      OR liquidation_rate_actual < sat_ngn_rate_at_creation × MIN_LIQUIDATION_RATE_FRACTION
 *
 * Per loan, in a single transaction:
 *   1. Update Loan: status → ACTIVE, liquidated_at → null, liquidation_rate_actual → null
 *   2. Insert LoanStatusLog: LIQUIDATED → ACTIVE, reason_code = LIQUIDATION_REVERSED_BAD_RATE,
 *      with the original (bad) rate captured in metadata.
 *
 * IMPORTANT — this is a forbidden backward transition under CLAUDE.md §5.4
 * ("Forward-only between distinct statuses — no backward transitions, ever").
 * This script bypasses LoanStatusService deliberately as a one-off ops fix
 * and is the *only* place such a reversal is permitted, alongside the
 * `POST /v1/ops/loans/:id/restore-from-bad-liquidation` endpoint.
 *
 * NOTE — `BlinkProvider.swapBtcToUsd` may already have run for these loans
 * (the swap is fire-and-forget after the liquidation tx commits). If it did,
 * Bitmonie's own Blink wallet now holds USD-stable instead of the original
 * BTC. That swap is NOT unwound by this script — ops must square the wallet
 * position manually. Restored loans show ACTIVE in the API; the customer's
 * collateral position is whole on the books regardless of internal wallet
 * shape.
 *
 * Usage:
 *   pnpm ops:restore-bad-liquidations                           # dry-run
 *   pnpm ops:restore-bad-liquidations -- --apply                # apply (with confirm)
 *   pnpm ops:restore-bad-liquidations -- --apply --force        # apply, no prompt
 *   pnpm ops:restore-bad-liquidations -- --apply --limit 5      # cap batch size
 *   pnpm ops:restore-bad-liquidations -- --loan-id <uuid>       # restrict scope
 *   pnpm ops:restore-bad-liquidations -- --reason "..."         # custom reason
 *   pnpm ops:restore-bad-liquidations -- --help
 */

import { PrismaClient, LoanStatus, StatusTrigger } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import Decimal from 'decimal.js';
import * as readline from 'node:readline/promises';
import { LoanReasonCodes, MIN_LIQUIDATION_RATE_FRACTION } from '@/common/constants';

const DEFAULT_REASON = 'Ops remediation: liquidation triggered by bad SAT/NGN rate';

interface CliArgs {
  apply:    boolean;
  force:    boolean;
  help:     boolean;
  limit:    number | null;
  reason:   string;
  loan_ids: string[];
}

interface AffectedLoan {
  id:                       string;
  user_id:                  string;
  principal_ngn:            string;
  collateral_amount_sat:    bigint;
  sat_ngn_rate_at_creation: Decimal;
  liquidation_rate_actual:  Decimal | null;
  liquidated_at:            Date | null;
  sanity_floor:             Decimal;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const args: CliArgs = {
    apply:    false,
    force:    false,
    help:     false,
    limit:    null,
    reason:   DEFAULT_REASON,
    loan_ids: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--apply':   args.apply = true; break;
      case '--force':   args.force = true; break;
      case '--help':
      case '-h':        args.help = true; break;
      case '--loan-id': {
        const v = argv[i + 1];
        if (!v) throw new Error('--loan-id requires a value');
        args.loan_ids.push(v);
        i++;
        break;
      }
      case '--reason': {
        const v = argv[i + 1];
        if (!v) throw new Error('--reason requires a value');
        args.reason = v;
        i++;
        break;
      }
      case '--limit': {
        const v = argv[i + 1];
        if (!v) throw new Error('--limit requires a value');
        const n = parseInt(v, 10);
        if (!Number.isFinite(n) || n <= 0) throw new Error('--limit must be a positive integer');
        args.limit = n;
        i++;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${a}. Pass --help for usage.`);
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(`
restore-bad-rate-liquidations — reverse loans liquidated by a glitched price feed.

Usage:
  pnpm ops:restore-bad-liquidations [-- <flags>]

Flags:
  --apply              Actually perform the restoration (default is dry-run).
  --force              Skip the interactive confirmation when --apply is set.
  --limit N            Cap the batch size at N loans (safety bound).
  --loan-id <uuid>     Restrict to specific loan id(s). Repeatable.
  --reason "<text>"    Reason text written to loan_status_logs.reason_detail.
  --help, -h           Show this help.

Examples:
  pnpm ops:restore-bad-liquidations
  pnpm ops:restore-bad-liquidations -- --apply
  pnpm ops:restore-bad-liquidations -- --apply --limit 5
  pnpm ops:restore-bad-liquidations -- --loan-id 11111111-2222-... --apply --force

Note: ${'`BlinkProvider.swapBtcToUsd`'} is NOT unwound by this script. Ops must
square the internal Blink wallet position separately if the swap ran.
`);
}

async function findAffected(prisma: PrismaClient, loan_ids: string[]): Promise<AffectedLoan[]> {
  const where = {
    status: LoanStatus.LIQUIDATED,
    ...(loan_ids.length > 0 ? { id: { in: loan_ids } } : {}),
  };

  const rows = await prisma.loan.findMany({
    where,
    select: {
      id:                       true,
      user_id:                  true,
      principal_ngn:            true,
      collateral_amount_sat:    true,
      sat_ngn_rate_at_creation: true,
      liquidation_rate_actual:  true,
      liquidated_at:            true,
    },
    orderBy: { liquidated_at: 'asc' },
  });

  return rows
    .map((r): AffectedLoan => {
      const rate_at_creation = new Decimal(r.sat_ngn_rate_at_creation.toString());
      return {
        id:                       r.id,
        user_id:                  r.user_id,
        principal_ngn:            r.principal_ngn.toString(),
        collateral_amount_sat:    r.collateral_amount_sat,
        sat_ngn_rate_at_creation: rate_at_creation,
        liquidation_rate_actual:  r.liquidation_rate_actual ? new Decimal(r.liquidation_rate_actual.toString()) : null,
        liquidated_at:            r.liquidated_at,
        sanity_floor:             rate_at_creation.mul(MIN_LIQUIDATION_RATE_FRACTION),
      };
    })
    .filter((loan) => {
      // null rate counts as bad — same broken-feed cascade.
      if (loan.liquidation_rate_actual === null) return true;
      return loan.liquidation_rate_actual.lt(loan.sanity_floor);
    });
}

async function restoreOne(prisma: PrismaClient, loan: AffectedLoan, reason: string): Promise<void> {
  // Generous timeouts — this is a one-off ops script that may run against a
  // remote DB. Defaults (maxWait=2s, timeout=5s) are tuned for in-cluster
  // services and trip on cold connections.
  await prisma.$transaction(async (tx) => {
    await tx.loan.update({
      where: { id: loan.id },
      data: {
        status:                  LoanStatus.ACTIVE,
        liquidated_at:           null,
        liquidation_rate_actual: null,
      },
    });

    await tx.loanStatusLog.create({
      data: {
        loan_id:       loan.id,
        user_id:       loan.user_id,
        from_status:   LoanStatus.LIQUIDATED,
        to_status:     LoanStatus.ACTIVE,
        triggered_by:  StatusTrigger.SYSTEM,
        reason_code:   LoanReasonCodes.LIQUIDATION_REVERSED_BAD_RATE,
        reason_detail: reason,
        metadata: {
          original_liquidation_rate_actual: loan.liquidation_rate_actual?.toString() ?? null,
          original_liquidated_at:           loan.liquidated_at?.toISOString() ?? null,
          sat_ngn_rate_at_creation:         loan.sat_ngn_rate_at_creation.toString(),
          min_liquidation_rate_fraction:    MIN_LIQUIDATION_RATE_FRACTION.toString(),
          script:                           'restore-bad-rate-liquidations.ts',
        },
      },
    });
  }, { maxWait: 15_000, timeout: 30_000 });
}

function printAffected(affected: AffectedLoan[]): void {
  process.stdout.write(`\nAffected loans (${affected.length}):\n`);
  for (const loan of affected) {
    process.stdout.write(
      `  ${loan.id}\n` +
      `    user=${loan.user_id}\n` +
      `    principal_ngn=${loan.principal_ngn}` +
      `  collateral_sat=${loan.collateral_amount_sat.toString()}\n` +
      `    rate_at_creation=${loan.sat_ngn_rate_at_creation.toFixed(6)}` +
      `  sanity_floor=${loan.sanity_floor.toFixed(6)}` +
      `  liquidation_rate=${loan.liquidation_rate_actual?.toFixed(6) ?? 'null'}\n` +
      `    liquidated_at=${loan.liquidated_at?.toISOString() ?? 'null'}\n`,
    );
  }
}

async function confirm(count: number): Promise<boolean> {
  if (!process.stdin.isTTY) {
    process.stderr.write('\nNon-interactive shell — pass --force to apply without prompting.\n');
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`\nRestore ${count} loan(s)? Type "yes" to confirm: `);
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }

  if (args.help) {
    printHelp();
    return;
  }

  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    process.stderr.write('DATABASE_URL is required\n');
    process.exit(1);
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DATABASE_URL }),
  });

  try {
    // Pay the cold-connection cost up front — without this, the first
    // $transaction() can exceed the maxWait timeout against a remote DB.
    await prisma.$connect();
    let affected = await findAffected(prisma, args.loan_ids);

    if (affected.length === 0) {
      process.stdout.write('No affected loans found.\n');
      return;
    }

    if (args.limit !== null && affected.length > args.limit) {
      process.stdout.write(
        `Capping batch from ${affected.length} → ${args.limit} (--limit). Earliest liquidations first.\n`,
      );
      affected = affected.slice(0, args.limit);
    }

    printAffected(affected);

    if (!args.apply) {
      process.stdout.write('\nDry run — pass --apply to restore.\n');
      return;
    }

    if (!args.force) {
      const ok = await confirm(affected.length);
      if (!ok) {
        process.stdout.write('Aborted.\n');
        return;
      }
    }

    process.stdout.write('\nApplying restoration…\n');
    let ok = 0;
    const failures: { id: string; error: string }[] = [];
    for (const loan of affected) {
      try {
        await restoreOne(prisma, loan, args.reason);
        ok++;
        process.stdout.write(`  restored ${loan.id}\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push({ id: loan.id, error: msg });
        process.stderr.write(`  FAILED ${loan.id}: ${msg}\n`);
      }
    }

    process.stdout.write(`\nRestored ${ok}/${affected.length}.\n`);
    if (failures.length > 0) {
      process.stderr.write(`Failures: ${JSON.stringify(failures, null, 2)}\n`);
      process.exit(1);
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  process.stderr.write(`FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
