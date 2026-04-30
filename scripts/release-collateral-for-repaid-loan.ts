#!/usr/bin/env node
/**
 * Ops one-off: release collateral SAT for a loan that is already REPAID
 * but whose collateral never went back to the customer.
 *
 * Why this exists: the live `creditInflow` path transitions a loan to REPAID
 * but DOES NOT trigger the collateral send. The columns
 * `collateral_release_address` / `collateral_released_at` /
 * `collateral_release_reference` exist in the schema, the provider has
 * `sendToLightningAddress`, but no code path connects the two on the REPAID
 * transition. The proper fix is a follow-up PR (post-commit release in
 * `creditInflow` + a `collateral-release` worker as a safety net). This
 * script unsticks individual loans in the meantime.
 *
 * Idempotency:
 *   - Refuses to run if `collateral_released_at IS NOT NULL` (already released).
 *   - Refuses to run if `status != REPAID` (only released-on-repaid is in
 *     scope for v1.1; surplus-on-LIQUIDATED is a separate path).
 *   - Refuses to run if `collateral_release_address IS NULL` (customer never
 *     set one — they need to PATCH /v1/loans/:id/release-address first).
 *
 * Usage:
 *   pnpm ops:release-collateral -- --loan-id <uuid>                       # dry-run
 *   pnpm ops:release-collateral -- --loan-id <uuid> --apply                # apply (with confirm)
 *   pnpm ops:release-collateral -- --loan-id <uuid> --apply --force        # apply, no prompt
 *   pnpm ops:release-collateral -- --help
 *
 * Failure handling: if Blink's lnAddressPaymentSend throws or returns
 * FAILURE, the loan row is NOT updated (collateral_released_at stays NULL),
 * so this script can be re-run after the underlying issue is fixed. Same
 * idempotency story as the proper fix's safety-net worker once it lands.
 */

import { PrismaClient } from '@prisma/client';
import { LoanStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as readline from 'node:readline/promises';
import { BlinkProvider } from '@/providers/blink/blink.provider';

interface CliArgs {
  loan_id: string | null;
  apply:   boolean;
  force:   boolean;
  help:    boolean;
  memo:    string;
}

const DEFAULT_MEMO = 'Bitmonie collateral release';

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const args: CliArgs = {
    loan_id: null,
    apply:   false,
    force:   false,
    help:    false,
    memo:    DEFAULT_MEMO,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--apply': args.apply = true; break;
      case '--force': args.force = true; break;
      case '--help':
      case '-h':      args.help = true; break;
      case '--loan-id': {
        const v = argv[i + 1];
        if (!v) throw new Error('--loan-id requires a value');
        args.loan_id = v;
        i++;
        break;
      }
      case '--memo': {
        const v = argv[i + 1];
        if (!v) throw new Error('--memo requires a value');
        args.memo = v;
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
release-collateral-for-repaid-loan — sends collateral SAT back to the customer's
Lightning address for a loan that is already REPAID but never had its
collateral released. Stop-gap until the proper post-commit release lands in
creditInflow.

Usage:
  pnpm ops:release-collateral -- --loan-id <uuid> [flags]

Flags:
  --loan-id <uuid>     The loan to release. Required.
  --apply              Actually send (default is dry-run — fetches state and
                       prints the plan without touching Blink or the DB).
  --force              Skip the interactive confirmation when --apply is set.
  --memo "<text>"      Memo to attach to the Lightning send. Default:
                       "${DEFAULT_MEMO}".
  --help, -h           Show this help.

Refuses to run if:
  - loan does not exist
  - loan.status != REPAID
  - loan.collateral_release_address IS NULL (customer must set one first)
  - loan.collateral_released_at IS NOT NULL (already released)
`);
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await rl.question(prompt)).trim().toLowerCase();
    return ans === 'y' || ans === 'yes';
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

  if (!args.loan_id) {
    process.stderr.write('--loan-id is required. Use --help for usage.\n');
    process.exit(2);
  }

  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    process.stderr.write('DATABASE_URL is required\n');
    process.exit(1);
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });

  try {
    const loan = await prisma.loan.findUnique({
      where: { id: args.loan_id },
      select: {
        id:                          true,
        user_id:                     true,
        status:                      true,
        collateral_amount_sat:       true,
        collateral_release_address:  true,
        collateral_released_at:      true,
        collateral_release_reference: true,
        repaid_at:                   true,
      },
    });

    if (!loan) {
      process.stderr.write(`Loan ${args.loan_id} not found.\n`);
      process.exit(1);
    }

    if (loan.status !== LoanStatus.REPAID) {
      process.stderr.write(
        `Loan ${loan.id} is in status ${loan.status}, not REPAID — refusing to release.\n` +
        `(Only REPAID is in scope for this script. LIQUIDATED surplus is a separate path.)\n`,
      );
      process.exit(1);
    }

    if (!loan.collateral_release_address) {
      process.stderr.write(
        `Loan ${loan.id} has no collateral_release_address — customer must call ` +
        `PATCH /v1/loans/:id/release-address first to set one.\n`,
      );
      process.exit(1);
    }

    if (loan.collateral_released_at !== null) {
      process.stderr.write(
        `Loan ${loan.id} already released at ${loan.collateral_released_at.toISOString()} ` +
        `(reference: ${loan.collateral_release_reference ?? '(none)'}). Nothing to do.\n`,
      );
      process.exit(0);
    }

    const plan = {
      loan_id:               loan.id,
      user_id:               loan.user_id,
      amount_sat:            loan.collateral_amount_sat.toString(),
      release_address:       loan.collateral_release_address,
      repaid_at:             loan.repaid_at?.toISOString() ?? null,
      memo:                  args.memo,
    };
    process.stdout.write(`${args.apply ? 'Apply plan' : 'Dry-run plan'}: ${JSON.stringify(plan, null, 2)}\n`);

    if (!args.apply) {
      process.stdout.write('Dry-run — pass --apply to actually send.\n');
      return;
    }

    if (!args.force) {
      const ok = await confirm(`Send ${loan.collateral_amount_sat} sat to ${loan.collateral_release_address}? [y/N] `);
      if (!ok) {
        process.stdout.write('Aborted.\n');
        return;
      }
    }

    const blink = new BlinkProvider({
      api_key:        process.env.BLINK_API_KEY        ?? '',
      base_url:       process.env.BLINK_BASE_URL        ?? 'https://api.blink.sv',
      wallet_btc_id:  process.env.BLINK_WALLET_BTC_ID   ?? '',
      wallet_usd_id:  process.env.BLINK_WALLET_USD_ID   ?? '',
      account_id:     process.env.BLINK_ACCOUNT_ID      ?? '',
      webhook_secret: process.env.BLINK_WEBHOOK_SECRET  ?? '',
    });

    let provider_reference: string;
    try {
      provider_reference = await blink.sendToLightningAddress({
        address:    loan.collateral_release_address,
        amount_sat: loan.collateral_amount_sat,
        memo:       args.memo,
      });
    } catch (err) {
      process.stderr.write(
        `Blink sendToLightningAddress threw — loan NOT updated, safe to re-run after fixing the cause:\n  ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }

    // Stamp the release on the loan AFTER the send succeeded. Order matters:
    // a successful send + failed DB update would mean we double-pay on next
    // run. So we keep the window where this can happen as small as possible
    // and make the DB update fast/local.
    await prisma.loan.update({
      where: { id: loan.id },
      data:  {
        collateral_released_at:       new Date(),
        collateral_release_reference: provider_reference,
      },
    });

    process.stdout.write(
      `Released ${loan.collateral_amount_sat} sat → ${loan.collateral_release_address}\n` +
      `  provider_reference: ${provider_reference}\n` +
      `  loan.id:            ${loan.id}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error('FAILED:', err);
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; meta?: unknown };
    if (e.code !== undefined) console.error('  code:', e.code);
    if (e.meta !== undefined) console.error('  meta:', JSON.stringify(e.meta, null, 2));
  }
  process.exit(1);
});
