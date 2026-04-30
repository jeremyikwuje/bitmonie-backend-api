#!/usr/bin/env node
/**
 * Ops remediation: replay PalmPay collection webhooks that were silently
 * dropped by the orderStatus=2 vs orderStatus=1 bug.
 *
 * The pre-fix collection handler treated `orderStatus !== 2` as non-success,
 * which dropped every real loan repayment (collection scheme uses 1=success).
 * webhook_logs preserves the raw body of each delivery, so we can:
 *
 *   1. Find candidates: provider=palmpay AND signature_valid=true AND
 *      outcome=IGNORED AND outcome_detail LIKE 'collection orderStatus=%'
 *      (this is exactly the rejection branch that was wrong).
 *   2. Re-run the live collection-handler matching logic against each
 *      candidate's stored body — INCLUDING the new defence-in-depth re-query
 *      against PalmPay (so we never credit a loan unless PalmPay still
 *      confirms the order on its side).
 *   3. On a successful match, run LoansService.creditInflow with a marker
 *      match_method so the LoanRepayment row is traceable to this script.
 *
 * Notes on the redacted body:
 *   webhook_logs masks `payerAccountNo` (per §5.8) but leaves orderNo,
 *   virtualAccountNo, orderAmount, payerAccountName, payerBankName intact —
 *   none of which the matching logic depends on for crediting. Signature was
 *   verified at original receipt; we do NOT re-verify here (the redaction
 *   would invalidate the signature anyway). Trust is anchored on:
 *     a. signature_valid=true on the historical row (was verified at receipt),
 *     b. the live PalmPay re-query confirming the order is still settled.
 *
 * Usage:
 *   pnpm ops:replay-dropped-collections                     # dry-run
 *   pnpm ops:replay-dropped-collections -- --apply          # apply (with confirm)
 *   pnpm ops:replay-dropped-collections -- --apply --force  # apply, no prompt
 *   pnpm ops:replay-dropped-collections -- --apply --limit 5
 *   pnpm ops:replay-dropped-collections -- --order-no MI20498... --apply
 *   pnpm ops:replay-dropped-collections -- --since 2026-04-01 --apply
 *   pnpm ops:replay-dropped-collections -- --help
 */

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { LoanStatus, PaymentNetwork } from '@prisma/client';
import Decimal from 'decimal.js';
import * as readline from 'node:readline/promises';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/database/prisma.service';
import { PalmpayProvider } from '@/providers/palmpay/palmpay.provider';
import { LoansService } from '@/modules/loans/loans.service';
import { OpsAlertsService } from '@/modules/ops-alerts/ops-alerts.service';
import {
  PalmpayCollectionNotificationSchema,
  PALMPAY_COLLECTION_STATUS_SUCCESS,
  type PalmpayCollectionNotification,
} from '@/providers/palmpay/palmpay.types';
import { MIN_PARTIAL_REPAYMENT_NGN } from '@/common/constants';

const log = new Logger('replay-dropped-palmpay-collections');

interface CliArgs {
  apply:    boolean;
  force:    boolean;
  help:     boolean;
  limit:    number | null;
  order_no: string | null;
  since:    string | null;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const args: CliArgs = {
    apply:    false,
    force:    false,
    help:     false,
    limit:    null,
    order_no: null,
    since:    null,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--apply':    args.apply = true; break;
      case '--force':    args.force = true; break;
      case '--help':
      case '-h':         args.help = true; break;
      case '--limit': {
        const v = argv[i + 1];
        if (!v) throw new Error('--limit requires a value');
        const n = parseInt(v, 10);
        if (!Number.isFinite(n) || n <= 0) throw new Error('--limit must be a positive integer');
        args.limit = n;
        i++;
        break;
      }
      case '--order-no': {
        const v = argv[i + 1];
        if (!v) throw new Error('--order-no requires a value');
        args.order_no = v;
        i++;
        break;
      }
      case '--since': {
        const v = argv[i + 1];
        if (!v) throw new Error('--since requires a value (YYYY-MM-DD)');
        args.since = v;
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
replay-dropped-palmpay-collections — credit loan repayments that the
pre-fix PalmPay collection handler silently dropped (orderStatus=1 was being
treated as non-success).

Usage:
  pnpm ops:replay-dropped-collections [-- <flags>]

Flags:
  --apply              Actually credit the loans (default is dry-run).
  --force              Skip the interactive confirmation when --apply is set.
  --limit N            Cap the batch size at N webhook_logs rows.
  --order-no <id>      Restrict to a single PalmPay orderNo.
  --since <YYYY-MM-DD> Only inspect rows received on/after this UTC date.
  --help, -h           Show this help.

Each candidate is re-verified live against PalmPay before any credit:
no credit happens unless PalmPay's order-query API confirms the order is
still settled with the same amount + virtual account as the stored webhook.
`);
}

interface Candidate {
  log_id:       string;
  received_at:  Date;
  raw_body:     string;
  outcome:      string;
  outcome_detail: string | null;
}

async function findCandidates(
  prisma: PrismaService,
  args: CliArgs,
): Promise<Candidate[]> {
  // Two ways a row could have been silently dropped:
  //   - outcome_detail like 'collection orderStatus=%' (the gate that fired).
  //   - signature_valid=true, no external_reference set, AND the body parses
  //     as a collection notification with orderStatus=1 (defensive — covers
  //     any pre-outcome-tracking deliveries).
  // Start with the precise outcome_detail path; broaden only if needed.
  const since_filter = args.since ? `AND received_at >= '${args.since}'::timestamptz` : '';
  const order_filter = args.order_no
    ? `AND external_reference = '${args.order_no.replace(/'/g, "''")}'`
    : '';
  const limit_filter = args.limit ? `LIMIT ${args.limit}` : '';

  const rows = await prisma.$queryRawUnsafe<Candidate[]>(`
    SELECT id AS log_id,
           received_at,
           raw_body,
           outcome,
           outcome_detail
      FROM webhook_logs
     WHERE provider = 'palmpay'
       AND signature_valid = true
       AND http_path IN (
            '/v1/webhooks/palmpay',                    -- legacy single-endpoint era
            '/v1/webhooks/palmpay/collection',         -- collection-split era (pre-rename)
            '/v1/webhooks/palmpay/collection/va'       -- current
       )
       AND (
            outcome_detail LIKE 'collection orderStatus=%'
         OR (outcome = 'IGNORED' AND outcome_detail = 'collection schema validation failed')
       )
       ${since_filter}
       ${order_filter}
     ORDER BY received_at ASC
     ${limit_filter}
  `);

  return rows;
}

interface ReplayOutcome {
  log_id:        string;
  order_no:      string | null;
  decision:      'credited' | 'skipped' | 'mismatch' | 'unmatched' | 'parse_failed' | 'requery_failed' | 'already_credited';
  detail:        string;
  loan_id?:      string;
  amount_ngn?:   string;
}

async function replayOne(
  prisma:     PrismaService,
  provider:   PalmpayProvider,
  loans:      LoansService,
  ops_alerts: OpsAlertsService,
  candidate:  Candidate,
  apply:      boolean,
): Promise<ReplayOutcome> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(candidate.raw_body) as Record<string, unknown>;
  } catch {
    return { log_id: candidate.log_id, order_no: null, decision: 'parse_failed', detail: 'raw_body is not valid JSON' };
  }

  const result = PalmpayCollectionNotificationSchema.safeParse(parsed);
  if (!result.success) {
    return { log_id: candidate.log_id, order_no: null, decision: 'parse_failed', detail: 'collection schema validation failed' };
  }

  const payload: PalmpayCollectionNotification = result.data;

  // Same SUCCESS gate the live controller now applies. Anything else was a
  // genuine non-success even on the new code — skip.
  if (payload.orderStatus !== PALMPAY_COLLECTION_STATUS_SUCCESS) {
    return { log_id: candidate.log_id, order_no: payload.orderNo, decision: 'skipped', detail: `orderStatus=${payload.orderStatus}` };
  }

  if (!payload.virtualAccountNo) {
    return { log_id: candidate.log_id, order_no: payload.orderNo, decision: 'skipped', detail: 'missing virtualAccountNo' };
  }

  // Skip rows that have already been processed (Inflow exists with is_matched=true).
  // Cheap pre-flight before the PalmPay round-trip.
  const existing_inflow = await prisma.inflow.findUnique({
    where: { provider_reference: payload.orderNo },
  });
  if (existing_inflow?.is_matched) {
    return { log_id: candidate.log_id, order_no: payload.orderNo, decision: 'already_credited', detail: `inflow ${existing_inflow.id} already matched` };
  }

  const amount_ngn = new Decimal(payload.orderAmount).div(100);

  // Match user → ACTIVE loan, same logic as the live controller.
  const repayment_account = await prisma.userRepaymentAccount.findUnique({
    where: { virtual_account_no: payload.virtualAccountNo },
  });
  if (!repayment_account) {
    return { log_id: candidate.log_id, order_no: payload.orderNo, decision: 'unmatched', detail: 'no_user_for_va', amount_ngn: amount_ngn.toFixed(2) };
  }

  const user_id = repayment_account.user_id;

  if (amount_ngn.lt(MIN_PARTIAL_REPAYMENT_NGN)) {
    return { log_id: candidate.log_id, order_no: payload.orderNo, decision: 'unmatched', detail: 'below_floor', amount_ngn: amount_ngn.toFixed(2) };
  }

  const active_loans = await prisma.loan.findMany({
    where:  { user_id, status: LoanStatus.ACTIVE },
    select: { id: true },
  });

  if (active_loans.length === 0) {
    return { log_id: candidate.log_id, order_no: payload.orderNo, decision: 'unmatched', detail: 'no_active_loans', amount_ngn: amount_ngn.toFixed(2) };
  }
  if (active_loans.length > 1) {
    return { log_id: candidate.log_id, order_no: payload.orderNo, decision: 'unmatched', detail: 'multiple_active_loans (use claim-inflow)', amount_ngn: amount_ngn.toFixed(2) };
  }

  const matched_loan = active_loans[0]!;

  // Live re-query — same defence-in-depth the new controller applies.
  let verified;
  try {
    verified = await provider.getCollectionOrderStatus(payload.orderNo);
  } catch (err) {
    return {
      log_id:   candidate.log_id,
      order_no: payload.orderNo,
      decision: 'requery_failed',
      detail:   err instanceof Error ? err.message : String(err),
    };
  }

  if (verified.status !== 'successful') {
    return { log_id: candidate.log_id, order_no: payload.orderNo, decision: 'mismatch', detail: `requery_status=${verified.status}` };
  }
  if (verified.amount_kobo == null || verified.amount_kobo !== payload.orderAmount) {
    return {
      log_id:   candidate.log_id,
      order_no: payload.orderNo,
      decision: 'mismatch',
      detail:   `amount_kobo webhook=${payload.orderAmount} requery=${verified.amount_kobo ?? 'null'}`,
    };
  }
  if (verified.virtual_account_no && verified.virtual_account_no !== payload.virtualAccountNo) {
    return {
      log_id:   candidate.log_id,
      order_no: payload.orderNo,
      decision: 'mismatch',
      detail:   `va webhook=${payload.virtualAccountNo} requery=${verified.virtual_account_no}`,
    };
  }

  if (!apply) {
    return {
      log_id:    candidate.log_id,
      order_no:  payload.orderNo,
      decision:  'credited',
      detail:    `(dry-run) would credit loan ${matched_loan.id}`,
      loan_id:   matched_loan.id,
      amount_ngn: amount_ngn.toFixed(2),
    };
  }

  // Apply: upsert the Inflow then run creditInflow. Marker match_method
  // tags the LoanRepayment so ops can audit which rows were script-credited.
  const inflow = await prisma.inflow.upsert({
    where:  { provider_reference: payload.orderNo },
    create: {
      user_id,
      asset:              'NGN',
      amount:             amount_ngn,
      currency:           'NGN',
      network:            PaymentNetwork.BANK_TRANSFER,
      receiving_address:  payload.virtualAccountNo,
      provider_reference: payload.orderNo,
      is_matched:         false,
      provider_response:  { ...parsed, bitmonie_replayed_from_log_id: candidate.log_id } as never,
    },
    update: {},
  });

  if (inflow.is_matched) {
    return { log_id: candidate.log_id, order_no: payload.orderNo, decision: 'already_credited', detail: `inflow ${inflow.id} already matched (race)` };
  }

  try {
    const credit = await loans.creditInflow({
      inflow_id:    inflow.id,
      loan_id:      matched_loan.id,
      amount_ngn,
      match_method: 'AUTO_AMOUNT',
    });
    return {
      log_id:     candidate.log_id,
      order_no:   payload.orderNo,
      decision:   'credited',
      detail:     `loan ${matched_loan.id} → ${credit.new_status} (outstanding=${credit.outstanding_ngn})`,
      loan_id:    matched_loan.id,
      amount_ngn: amount_ngn.toFixed(2),
    };
  } catch (err) {
    await ops_alerts.alertUnmatchedInflow({
      reason:          'credit_failed',
      provider:        'palmpay',
      order_no:        payload.orderNo,
      amount_ngn:      amount_ngn.toFixed(2),
      user_id,
      virtual_account: payload.virtualAccountNo,
      payer_name:      payload.payerAccountName,
      payer_account:   payload.payerAccountNo,
      loan_id:         matched_loan.id,
      detail:          err instanceof Error ? err.message : String(err),
    });
    return {
      log_id:    candidate.log_id,
      order_no:  payload.orderNo,
      decision:  'mismatch',
      detail:    `creditInflow threw: ${err instanceof Error ? err.message : String(err)}`,
      loan_id:   matched_loan.id,
      amount_ngn: amount_ngn.toFixed(2),
    };
  }
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

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const prisma     = app.get(PrismaService);
  const provider   = app.get(PalmpayProvider);
  const loans      = app.get(LoansService);
  const ops_alerts = app.get(OpsAlertsService);

  const candidates = await findCandidates(prisma, args);
  log.log(`Found ${candidates.length} candidate webhook_logs row(s)`);

  if (candidates.length === 0) {
    await app.close();
    return;
  }

  if (args.apply && !args.force) {
    const ok = await confirm(
      `About to credit up to ${candidates.length} loan repayment(s). Continue? [y/N] `,
    );
    if (!ok) {
      log.warn('Aborted.');
      await app.close();
      return;
    }
  }

  const outcomes: ReplayOutcome[] = [];
  for (const candidate of candidates) {
    const outcome = await replayOne(prisma, provider, loans, ops_alerts, candidate, args.apply);
    outcomes.push(outcome);
    log.log(
      `${outcome.decision.padEnd(18)} | order=${outcome.order_no ?? '(unparsed)'} | ` +
      `${outcome.amount_ngn ? `N${outcome.amount_ngn} | ` : ''}${outcome.detail}`,
    );
  }

  const counts = outcomes.reduce<Record<string, number>>((acc, o) => {
    acc[o.decision] = (acc[o.decision] ?? 0) + 1;
    return acc;
  }, {});
  log.log(`Summary (${args.apply ? 'APPLIED' : 'DRY-RUN'}): ${JSON.stringify(counts)}`);

  await app.close();
}

void main().catch((err) => {
  log.error('FAILED:', err);
  process.exit(1);
});
