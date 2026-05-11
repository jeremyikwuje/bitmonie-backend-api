#!/usr/bin/env node
/**
 * One-off backfill: strip the merchant brand suffix PalmPay echoes back on
 * virtualAccountName when provisioning a VA. PalmPay returns names shaped like
 * "Jeremiah Ikwuje(PROCESSWITH SOFTWARE LIMITED)"; the customer sees this on
 * repayment-instruction emails and on /v1/auth/me, so the persisted column
 * needs to be just "First Last".
 *
 * The provider layer now strips this at provisioning time
 * (PalmpayProvider.createVirtualAccount in src/providers/palmpay/palmpay.provider.ts).
 * This script cleans rows that were persisted before that fix shipped.
 *
 * Idempotent: a row whose name has no '(' is left alone. Running twice is a
 * no-op on the second pass.
 *
 * Usage:
 *   pnpm ops:clean-va-names                    # dry-run (default)
 *   pnpm ops:clean-va-names -- --apply         # write changes
 *   pnpm ops:clean-va-names -- --apply --limit 100
 *   pnpm ops:clean-va-names -- --help
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/database/prisma.service';

interface CliArgs {
  apply: boolean;
  limit: number | null;
  help:  boolean;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const args: CliArgs = { apply: false, limit: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--':      break;
      case '--apply': args.apply = true; break;
      case '--help':
      case '-h':      args.help = true; break;
      case '--limit': {
        const v = argv[i + 1];
        if (!v) throw new Error('--limit requires a value');
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) throw new Error('--limit must be a positive integer');
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
clean-repayment-account-names — strips merchant brand suffix from
user_repayment_accounts.virtual_account_name (e.g. "Jeremiah Ikwuje(PROCESSWITH
SOFTWARE LIMITED)" → "Jeremiah Ikwuje").

Usage:
  pnpm ops:clean-va-names [-- flags]

Flags:
  --apply         Actually write the cleaned names (default is dry-run).
  --limit <n>     Stop after touching <n> rows.
  --help, -h      Show this help.

Output: a summary of scanned / cleaned / already-clean rows, plus a per-row
preview of every change.
`);
}

// Mirrors stripMerchantSuffix in src/providers/palmpay/palmpay.provider.ts.
// Kept inline so the script has zero dependency on provider internals — this
// is a backfill, the provider may change shape over time.
function stripMerchantSuffix(name: string): string {
  const open = name.indexOf('(');
  const head = open >= 0 ? name.slice(0, open) : name;
  return head.replace(/\s+/g, ' ').trim();
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

  try {
    const prisma = app.get(PrismaService);

    const rows = await prisma.userRepaymentAccount.findMany({
      select: {
        id:                   true,
        user_id:              true,
        virtual_account_no:   true,
        virtual_account_name: true,
      },
      orderBy: { created_at: 'asc' },
      ...(args.limit !== null ? { take: args.limit } : {}),
    });

    let cleaned = 0;
    let already_clean = 0;

    process.stdout.write(`Scanning ${rows.length} user_repayment_accounts row(s) (${args.apply ? 'apply' : 'dry-run'})…\n`);

    for (const row of rows) {
      const cleaned_name = stripMerchantSuffix(row.virtual_account_name);
      if (cleaned_name === row.virtual_account_name) {
        already_clean++;
        continue;
      }

      // Defensive: refuse to write an empty name. If that ever happens it
      // means the provider returned something like "(MERCHANT)" with no
      // leading person name — surface it for ops, do not silently blank
      // the row.
      if (cleaned_name === '') {
        process.stderr.write(
          `  SKIP empty result row=${row.id} user=${row.user_id} va=${row.virtual_account_no} ` +
          `original=${JSON.stringify(row.virtual_account_name)}\n`,
        );
        continue;
      }

      process.stdout.write(
        `  ${args.apply ? 'CLEAN' : 'would clean'} va=${row.virtual_account_no} ` +
        `${JSON.stringify(row.virtual_account_name)} → ${JSON.stringify(cleaned_name)}\n`,
      );

      if (args.apply) {
        await prisma.userRepaymentAccount.update({
          where: { id: row.id },
          data:  { virtual_account_name: cleaned_name },
        });
      }
      cleaned++;
    }

    process.stdout.write(`\nSummary:\n`);
    process.stdout.write(`  scanned:        ${rows.length}\n`);
    process.stdout.write(`  ${args.apply ? 'cleaned' : 'would clean'}: ${cleaned}\n`);
    process.stdout.write(`  already clean:  ${already_clean}\n`);

    if (!args.apply && cleaned > 0) {
      process.stdout.write(`\nDry-run — pass --apply to write changes.\n`);
    }
  } finally {
    await app.close();
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
