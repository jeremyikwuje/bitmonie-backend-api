#!/usr/bin/env node
/**
 * One-off backfill: PalmPay's 0100… virtual accounts are hosted by Boost MFB,
 * but were persisted (and shown on repayment-instruction emails) as Bloom MFB.
 * PalmPay moved new VAs from Bloom (99… numbers) to Boost (0100…) in late July
 * 2026; the provider kept labelling them Bloom until 2026-10-27, so customers
 * picked the wrong bank and their repayments never arrived.
 *
 * The provider now labels new VAs Boost. This script corrects rows persisted
 * before that fix shipped. Only 0100… rows are touched — the 99… rows really
 * are Bloom.
 *
 * It also lists repayments into these VAs that the webhook DEFERRED: PalmPay's
 * order lookup cannot find Boost orders, so they were acknowledged and never
 * credited. Once the webhook fix is live, resend each one from PalmPay's Svix
 * dashboard (or credit it through the claim path). That report is read-only.
 *
 * Idempotent: a row already labelled Boost is left alone.
 *
 * Usage:
 *   pnpm ops:correct-va-bank-name              # dry-run (default)
 *   pnpm ops:correct-va-bank-name -- --apply   # write changes
 *   pnpm ops:correct-va-bank-name -- --help
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/database/prisma.service';

// Mirrors PALMPAY_VA_DEFAULT_BANK_NAME in src/providers/palmpay/palmpay.provider.ts.
// Inline for the same reason as clean-repayment-account-names.ts: this is a
// backfill, the provider may change shape over time.
const BOOST_BANK_NAME = 'Boost Microfinance Bank';
const BOOST_VA_PREFIX = '0100';

interface CliArgs {
  apply: boolean;
  help:  boolean;
}

function parseArgs(): CliArgs {
  const args: CliArgs = { apply: false, help: false };
  for (const a of process.argv.slice(2)) {
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
correct-repayment-account-bank-name — relabels user_repayment_accounts rows
whose VA number starts ${BOOST_VA_PREFIX} as "${BOOST_BANK_NAME}", and lists
DEFERRED PalmPay repayments into those VAs that still need crediting.

Usage:
  pnpm ops:correct-va-bank-name [-- flags]

Flags:
  --apply         Actually write the corrected bank names (default is dry-run).
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

  try {
    const prisma = app.get(PrismaService);

    // ── 1. Bank names ─────────────────────────────────────────────────────────
    const rows = await prisma.userRepaymentAccount.findMany({
      where: {
        virtual_account_no: { startsWith: BOOST_VA_PREFIX },
        bank_name:          { not: BOOST_BANK_NAME },
      },
      select:  { id: true, user_id: true, virtual_account_no: true, bank_name: true, created_at: true },
      orderBy: { created_at: 'asc' },
    });

    process.stdout.write(`${rows.length} ${BOOST_VA_PREFIX}… repayment account(s) not labelled Boost (${args.apply ? 'apply' : 'dry-run'})…\n`);
    for (const row of rows) {
      process.stdout.write(
        `  ${args.apply ? 'FIX' : 'would fix'} va=${row.virtual_account_no} user=${row.user_id} ` +
        `issued=${row.created_at.toISOString().slice(0, 10)} ${JSON.stringify(row.bank_name)} → ${JSON.stringify(BOOST_BANK_NAME)}\n`,
      );
    }
    if (args.apply && rows.length > 0) {
      const result = await prisma.userRepaymentAccount.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data:  { bank_name: BOOST_BANK_NAME },
      });
      process.stdout.write(`  corrected: ${result.count}\n`);
    }

    // ── 2. Deferred repayments (read-only) ───────────────────────────────────
    const deferred = await prisma.webhookLog.findMany({
      where: {
        provider:  'palmpay',
        http_path: '/v1/webhooks/palmpay/collection/va',
        outcome:   'DEFERRED',
      },
      select:  { received_at: true, raw_body: true, outcome_detail: true, external_reference: true },
      orderBy: { received_at: 'asc' },
    });

    const seen = new Set<string>();
    const pending: string[] = [];
    for (const log of deferred) {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(log.raw_body) as Record<string, unknown>; } catch { /* listed by reference only */ }
      const order_no = String(body.orderNo ?? log.external_reference ?? '');
      if (!order_no || seen.has(order_no)) continue;
      seen.add(order_no);
      // Skip anything a later delivery or ops already credited.
      const inflow = await prisma.inflow.findUnique({
        where:  { provider_reference: order_no },
        select: { is_matched: true },
      });
      if (inflow?.is_matched) continue;
      const amount = typeof body.orderAmount === 'number' ? (body.orderAmount / 100).toFixed(2) : '?';
      pending.push(
        `  order=${order_no} va=${String(body.virtualAccountNo ?? '?')} ngn=${amount} ` +
        `payer=${JSON.stringify(body.payerAccountName ?? '')} at=${log.received_at.toISOString()} (${log.outcome_detail ?? ''})`,
      );
    }

    process.stdout.write(`\n${pending.length} deferred PalmPay repayment(s) not yet credited — resend from Svix once the webhook fix is live:\n`);
    for (const line of pending) process.stdout.write(`${line}\n`);

    if (!args.apply && rows.length > 0) {
      process.stdout.write(`\nDry-run — pass --apply to correct the bank names.\n`);
    }
  } finally {
    await app.close();
  }
}

void main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
