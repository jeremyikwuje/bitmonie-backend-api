#!/usr/bin/env node
/**
 * One-off: gives every customer still on a Bloom MFB (99…) repayment VA a new
 * Boost MFB (0100…) one, and retires the Bloom VA. PalmPay issues new VAs on
 * Boost; the Bloom ones are the pre-July-2026 accounts.
 *
 * Per customer, the new VA is issued first and the Bloom VA is deactivated
 * only once that succeeds (UserRepaymentAccountsService.replaceForUser), so a
 * PalmPay refusal leaves them on their working Bloom VA. Retired rows are
 * kept: the collection webhook routes by VA number, so a transfer into the old
 * account still credits the customer.
 *
 * Customers with an ACTIVE loan are emailed the new account, since they are
 * the ones about to repay. The rest see it in the app.
 *
 * PalmPay only answers allowlisted IPs, so --apply must run on Railway (the
 * bitmonie-backend-api service), not a laptop.
 *
 * Idempotent: a customer already moved has no active Bloom VA and is skipped.
 *
 * Usage:
 *   pnpm ops:replace-bloom-vas              # dry-run (default)
 *   pnpm ops:replace-bloom-vas -- --apply   # issue new VAs, retire Bloom ones, email
 *   pnpm ops:replace-bloom-vas -- --apply --user=<user id>   # one customer only
 *   pnpm ops:replace-bloom-vas -- --help
 */

import { NestFactory } from '@nestjs/core';
import { LoanStatus } from '@prisma/client';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/database/prisma.service';
import { UserRepaymentAccountsService } from '@/modules/user-repayment-accounts/user-repayment-accounts.service';
import { LoanNotificationsService } from '@/modules/loan-notifications/loan-notifications.service';

const BLOOM_BANK_NAME = 'Bloom Microfinance Bank';

interface CliArgs {
  apply:    boolean;
  help:     boolean;
  user_id?: string;
}

function parseArgs(): CliArgs {
  const args: CliArgs = { apply: false, help: false };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--user=')) {
      args.user_id = a.slice('--user='.length);
      continue;
    }
    switch (a) {
      case '--':      break;
      case '--apply': args.apply = true; break;
      case '--help':
      case '-h':      args.help = true; break;
      default:
        throw new Error(`Unknown argument: ${a}. Pass --help for usage.`);
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(`
replace-bloom-repayment-accounts — issues a new Boost VA to every customer
whose active repayment VA is "${BLOOM_BANK_NAME}", retires the Bloom VA, and
emails the customers with an ACTIVE loan.

Usage:
  pnpm ops:replace-bloom-vas [-- flags]

Flags:
  --apply         Actually issue, retire and email (default is dry-run).
  --user=<id>     Only this customer (e.g. to try one before the rest).
  --help, -h      Show this help.
`);
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

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  let failed = 0;
  try {
    const prisma        = app.get(PrismaService);
    const accounts      = app.get(UserRepaymentAccountsService);
    const notifications = app.get(LoanNotificationsService);

    const rows = await prisma.userRepaymentAccount.findMany({
      where:   { is_active: true, bank_name: BLOOM_BANK_NAME, ...(args.user_id && { user_id: args.user_id }) },
      select:  { user_id: true, virtual_account_no: true, created_at: true },
      orderBy: { created_at: 'asc' },
    });

    process.stdout.write(`${rows.length} customer(s) on a Bloom repayment VA (${args.apply ? 'apply' : 'dry-run'})…\n`);

    let replaced = 0;
    let skipped  = 0;
    let emailed  = 0;
    for (const row of rows) {
      const active_loans = await prisma.loan.count({
        where: { user_id: row.user_id, status: LoanStatus.ACTIVE },
      });
      const who = `user=${row.user_id} bloom=${row.virtual_account_no} active_loans=${active_loans}`;

      if (!args.apply) {
        process.stdout.write(`  would replace ${who}${active_loans > 0 ? ' → email' : ''}\n`);
        continue;
      }

      try {
        const result = await accounts.replaceForUser(row.user_id);
        if (!result) {
          skipped += 1;
          process.stdout.write(`  SKIP ${who} — tier-1 KYC cannot back a new VA; Bloom VA left active\n`);
          continue;
        }
        replaced += 1;
        process.stdout.write(`  REPLACED ${who} → ${result.summary.bank_name} ${result.summary.virtual_account_no}\n`);

        if (active_loans > 0 && result.retired) {
          await notifications.notifyRepaymentAccountChanged({
            user_id:          row.user_id,
            previous_account: result.retired,
          });
          emailed += 1;
          process.stdout.write(`    emailed the new account\n`);
        }
      } catch (err) {
        failed += 1;
        process.stdout.write(
          `  FAILED ${who} — ${err instanceof Error ? err.message : String(err)}; Bloom VA left active\n`,
        );
      }
    }

    if (args.apply) {
      process.stdout.write(`\nreplaced=${replaced} emailed=${emailed} skipped=${skipped} failed=${failed}\n`);
    } else if (rows.length > 0) {
      process.stdout.write(`\nDry-run — pass --apply to replace them.\n`);
    }
  } finally {
    await app.close();
  }

  if (failed > 0) process.exit(1);
}

void main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
