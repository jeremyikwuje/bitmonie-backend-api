/**
 * Collateral Release Cycle — hosted by the liquidation-monitor worker.
 *
 * NOT a standalone Node process. The cycle function below is invoked on its
 * own setInterval inside `liquidation-monitor.worker.ts` so the two loan-
 * monitoring sweeps (LIVE coverage / collateral release) share the same
 * Railway service. See `railway/README.md` for the deployment topology.
 *
 * Safety net for the post-commit fire-and-forget release in
 * LoansService.creditInflow. Periodically scans loans where:
 *   status = REPAID
 *   collateral_released_at IS NULL
 *   collateral_release_address IS NOT NULL
 *
 * For each eligible loan, calls CollateralReleaseService.releaseForLoan —
 * the same code path the post-commit hand-off and the ops endpoint use.
 * Concurrency between the three is coordinated by a per-loan Redis SETNX
 * lock inside the service, so a loan that's currently being processed
 * elsewhere is skipped cleanly (status=in_flight return, no error).
 *
 * On send failure: the service emits an ops alert (rate-limited to one
 * per 24h per loan via Redis dedupe), and the cycle just keeps trying on
 * each tick. When the customer (or ops) updates the release address via
 * PATCH /v1/loans/:id/release-address or POST /v1/ops/loans/:id/release-collateral,
 * the dedupe key is cleared so the next failure pages ops fresh.
 */

import { PrismaClient, LoanStatus } from '@prisma/client';
import Redis from 'ioredis';
import { REDIS_KEYS } from '@/common/constants';
import { CollateralReleaseService } from '@/modules/loans/collateral-release.service';

// Cap how many loans a single tick processes. Prevents a one-time backlog
// (e.g. provider was down for hours) from holding the Redis lock + DB
// connection for the full set in one cycle. The next tick picks up the rest.
const MAX_LOANS_PER_CYCLE = 50;

export interface CollateralReleaseWorkerDeps {
  prisma:             PrismaClient;
  redis:              Redis;
  collateral_release: CollateralReleaseService;
  log: (level: string, event: string, extra?: Record<string, unknown>) => void;
  now?: () => Date;
}

type EligibleRow = {
  id:                          string;
  user_id:                     string;
  collateral_amount_sat:       bigint;
  collateral_release_address:  string | null;
};

export async function runCollateralReleaseCycle(deps: CollateralReleaseWorkerDeps): Promise<void> {
  const { prisma, redis, collateral_release, log } = deps;

  // FOR UPDATE SKIP LOCKED so concurrent reconciler instances don't both
  // claim the same loan rows — required by CLAUDE.md §12.
  const eligible = await prisma.$queryRaw<EligibleRow[]>`
    SELECT id, user_id, collateral_amount_sat, collateral_release_address
      FROM loans
     WHERE status = ${LoanStatus.REPAID}::"LoanStatus"
       AND collateral_released_at IS NULL
       AND collateral_release_address IS NOT NULL
     ORDER BY repaid_at ASC NULLS FIRST
     LIMIT ${MAX_LOANS_PER_CYCLE}
       FOR UPDATE SKIP LOCKED
  `;

  await redis.set(REDIS_KEYS.WORKER_HEARTBEAT('collateral_release'), Date.now().toString());

  if (eligible.length === 0) return;

  let released         = 0;
  let already_released = 0;
  let in_flight        = 0;
  let send_failed      = 0;
  let not_eligible     = 0;
  let errors           = 0;

  for (const row of eligible) {
    try {
      const result = await collateral_release.releaseForLoan(row.id);

      switch (result.status) {
        case 'released':
          released++;
          log('info', 'released', {
            loan_id:    row.id,
            user_id:    row.user_id,
            amount_sat: row.collateral_amount_sat.toString(),
            reference:  result.reference,
          });
          break;
        case 'already_released':
          already_released++;
          log('debug', 'already_released', { loan_id: row.id, reference: result.reference });
          break;
        case 'in_flight':
          in_flight++;
          log('debug', 'in_flight', { loan_id: row.id });
          break;
        case 'not_eligible':
          not_eligible++;
          // Loan was eligible at SELECT-time but the service rejected — most
          // commonly because the post-commit hand-off raced ahead and stamped
          // it between our SELECT and the lock acquire. Logged at info so
          // it's visible but not noisy.
          log('info', 'not_eligible', { loan_id: row.id, reason: result.reason });
          break;
        case 'send_failed':
          send_failed++;
          // Provider rejected the send. Service has already alerted ops
          // (rate-limited via Redis dedupe). Worker will retry next tick;
          // if the cause is a bad customer address, alert recurs once per
          // 24h until the address is fixed.
          log('warn', 'send_failed', { loan_id: row.id, error: result.error });
          break;
      }
    } catch (err) {
      errors++;
      log('error', 'release_threw', {
        loan_id: row.id,
        error:   err instanceof Error ? err.message : String(err),
      });
    }
  }

  log('info', 'cycle_complete', {
    eligible_count: eligible.length,
    released,
    already_released,
    in_flight,
    send_failed,
    not_eligible,
    errors,
  });
}
