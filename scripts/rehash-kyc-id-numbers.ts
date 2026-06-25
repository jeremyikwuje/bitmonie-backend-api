#!/usr/bin/env node
/**
 * One-off backfill: rehash every kyc_verifications row's id_number_hash
 * using the new deterministic CryptoService.hashKycIdNumber() (pepper-based).
 *
 * Why this exists: the legacy hash used a per-row random salt that was never
 * persisted, so the existing column values are useless for cross-row lookups.
 * The new (id_type, id_number_hash) partial unique index needs deterministic
 * hashes to enforce "one user per BVN/NIN". This script decrypts each row's
 * encrypted_id_number, recomputes the hash with the global pepper, and writes
 * it back.
 *
 * Order of operations in production:
 *   1. Set KYC_ID_HASH_PEPPER in env.
 *   2. Apply migration 20260510000000_kyc_unique_id_number (creates the index).
 *   3. Run this script (--dry-run first, then --apply).
 *   4. If conflicts are reported, ops manually decides which row keeps the ID
 *      (delete the loser) and re-runs.
 *
 * The unique index in step 2 is what surfaces duplicates as P2002 during
 * step 3 — running the rehash before the index would silently produce
 * colliding hashes. Running after the index is the safer order.
 *
 * Idempotent: a row whose stored id_number_hash already matches the
 * pepper-computed hash is left alone. Running twice is a no-op on the
 * second pass.
 *
 * Usage:
 *   pnpm ops:rehash-kyc-ids                  # dry-run (default)
 *   pnpm ops:rehash-kyc-ids -- --apply       # write changes
 *   pnpm ops:rehash-kyc-ids -- --apply --limit 100   # cap rows touched
 *   pnpm ops:rehash-kyc-ids -- --help
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';
import { CryptoService } from '@/common/crypto/crypto.service';
import { PrismaService } from '@/database/prisma.service';

interface CliArgs {
  apply: boolean;
  limit: number | null;
  help:  boolean;
}

const PRISMA_UNIQUE_VIOLATION = 'P2002';

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const args: CliArgs = { apply: false, limit: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--':      break; // pnpm passes the separator through; ignore
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
rehash-kyc-id-numbers — rebuilds id_number_hash on every kyc_verifications row
using the deterministic pepper-based hash. Run AFTER the unique-index
migration has been applied.

Usage:
  pnpm ops:rehash-kyc-ids [-- flags]

Flags:
  --apply         Actually write the new hashes (default is dry-run).
  --limit <n>     Stop after touching <n> rows. Useful for testing on a
                  subset before a full backfill.
  --help, -h      Show this help.

Output: a summary of scanned / rehashed / already-correct / conflict rows.
Conflicts (P2002 from the unique index) are listed individually for ops
to resolve before re-running.
`);
}

interface Conflict {
  row_id:  string;
  user_id: string;
  id_type: string;
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
    const crypto = app.get(CryptoService);

    const rows = await prisma.kycVerification.findMany({
      where: {
        id_type:             { not: null },
        encrypted_id_number: { not: null },
      },
      select: {
        id:                  true,
        user_id:             true,
        id_type:             true,
        id_number_hash:      true,
        encrypted_id_number: true,
      },
      orderBy: { created_at: 'asc' },
      ...(args.limit !== null ? { take: args.limit } : {}),
    });

    let rehashed = 0;
    let already_correct = 0;
    let decrypt_failed = 0;
    const conflicts: Conflict[] = [];

    process.stdout.write(`Scanning ${rows.length} kyc_verifications row(s) (${args.apply ? 'apply' : 'dry-run'})…\n`);

    for (const row of rows) {
      if (!row.encrypted_id_number || !row.id_type) continue;

      let id_number: string;
      try {
        id_number = crypto.decrypt(row.encrypted_id_number);
      } catch (err) {
        decrypt_failed++;
        process.stderr.write(
          `  decrypt FAILED row=${row.id} user=${row.user_id}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        continue;
      }

      const new_hash = crypto.hashKycIdNumber(id_number);
      if (new_hash === row.id_number_hash) {
        already_correct++;
        continue;
      }

      if (!args.apply) {
        rehashed++;
        continue;
      }

      try {
        await prisma.kycVerification.update({
          where: { id: row.id },
          data:  { id_number_hash: new_hash },
        });
        rehashed++;
      } catch (err) {
        if (
          err && typeof err === 'object' && 'code' in err &&
          (err as { code: string }).code === PRISMA_UNIQUE_VIOLATION
        ) {
          conflicts.push({ row_id: row.id, user_id: row.user_id, id_type: row.id_type });
          continue;
        }
        throw err;
      }
    }

    process.stdout.write(`\nSummary:\n`);
    process.stdout.write(`  scanned:         ${rows.length}\n`);
    process.stdout.write(`  ${args.apply ? 'rehashed' : 'would rehash'}: ${rehashed}\n`);
    process.stdout.write(`  already correct: ${already_correct}\n`);
    process.stdout.write(`  decrypt failed:  ${decrypt_failed}\n`);
    process.stdout.write(`  conflicts:       ${conflicts.length}\n`);

    if (conflicts.length > 0) {
      process.stdout.write(`\nConflicting rows (another user already holds this id_type+id_number_hash):\n`);
      for (const c of conflicts) {
        process.stdout.write(`  - row=${c.row_id} user=${c.user_id} id_type=${c.id_type}\n`);
      }
      process.stdout.write(
        `\nResolve by deciding which user keeps the ID, deleting the losing\n` +
        `kyc_verifications row(s), and re-running this script.\n`,
      );
    }

    if (!args.apply && rehashed > 0) {
      process.stdout.write(`\nDry-run — pass --apply to write changes.\n`);
    }

    const exit_code = (decrypt_failed + conflicts.length) > 0 ? 1 : 0;
    process.exit(exit_code);
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
