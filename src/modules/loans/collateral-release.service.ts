import { Inject, Injectable, Logger } from '@nestjs/common';
import { LoanStatus, StatusTrigger } from '@prisma/client';
import { Decimal } from 'decimal.js';
import type Redis from 'ioredis';
import { PrismaService } from '@/database/prisma.service';
import { REDIS_CLIENT } from '@/database/redis.module';
import {
  COLLATERAL_PROVIDER,
  type CollateralProvider,
} from '@/modules/payment-requests/collateral.provider.interface';
import { OpsAlertsService } from '@/modules/ops-alerts/ops-alerts.service';
import { LoanNotificationsService } from '@/modules/loan-notifications/loan-notifications.service';
import { LoanReasonCodes, REDIS_KEYS } from '@/common/constants';
import { LoanStatusService } from './loan-status.service';

// How long the per-loan SETNX lock is held while a release attempt is in
// flight. Long enough that a single Blink lnAddressPaymentSend round-trip
// can't outlast it; short enough that a crashed process won't hold the
// loan stuck for hours. The same key is set/released by all three callers
// (creditInflow post-commit hand-off, ops endpoint, worker).
const RELEASE_LOCK_TTL_SEC = 60;

// First-failure-per-day dedupe for ops alerts. The worker re-attempts on
// every tick, but we don't want ops getting an email every minute while
// they investigate. 24h gives time to fix and re-trigger.
const RELEASE_ALERT_DEDUPE_TTL_SEC = 24 * 60 * 60;

export type ReleaseResult =
  | { status: 'released';         reference: string }
  | { status: 'already_released'; reference: string | null }
  | { status: 'not_eligible';     reason: string }
  | { status: 'in_flight' }
  | { status: 'send_failed';      error: string };

// Owns the actual SAT release back to the customer when a loan reaches
// REPAID. Three callers — all of them go through releaseForLoan and all
// of them coordinate via the same Redis lock so a customer never gets
// double-paid:
//
//   1. LoansService.creditInflow (post-commit fire-and-forget on REPAID)
//   2. OpsLoansController (manual ops trigger when the auto path is wedged)
//   3. workers/collateral-release.worker.ts (safety net for retries)
//
// The atomic "stamp the release" step lives inside a Prisma transaction
// alongside a status_log row (REPAID → REPAID self-transition with
// reason_code=COLLATERAL_RELEASED). The provider call is OUTSIDE that tx
// — long-held connection on a remote API call is the wrong shape, and the
// lock above protects against re-sending if the post-send DB update fails.
@Injectable()
export class CollateralReleaseService {
  private readonly logger = new Logger(CollateralReleaseService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(COLLATERAL_PROVIDER)
    private readonly collateral_provider: CollateralProvider,
    private readonly loan_status: LoanStatusService,
    private readonly ops_alerts: OpsAlertsService,
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
    private readonly notifications: LoanNotificationsService,
  ) {}

  // Memo we send to Blink alongside the SAT — visible in the customer's
  // Lightning wallet ledger as the human-readable description. We include
  // the total NGN repaid plus the 8-char short-form loan ID (same format
  // used in customer emails) so the customer can trace this exact release
  // back to a specific loan from their wallet history alone.
  private buildMemo(loan_id: string, total_repaid_ngn: Decimal): string {
    const sid = loan_id.replace(/-/g, '').slice(0, 8).toUpperCase();
    const [whole, frac = '00'] = total_repaid_ngn.toFixed(2).split('.');
    const grouped = (whole ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `Bitmonie collateral released — ₦${grouped}.${frac} loan (${sid}) paid`;
  }

  async releaseForLoan(loan_id: string): Promise<ReleaseResult> {
    const lock_key = REDIS_KEYS.COLLATERAL_RELEASE_LOCK(loan_id);
    const acquired = await this.redis.set(lock_key, '1', 'EX', RELEASE_LOCK_TTL_SEC, 'NX');
    if (acquired !== 'OK') {
      // Another caller is mid-flight; back off cleanly. Worker will retry
      // on its next tick if this attempt is the one that wins and stamps.
      return { status: 'in_flight' };
    }

    try {
      const loan = await this.prisma.loan.findUnique({
        where: { id: loan_id },
        select: {
          id:                          true,
          user_id:                     true,
          status:                      true,
          collateral_amount_sat:       true,
          collateral_release_address:  true,
          collateral_released_at:      true,
          collateral_release_reference: true,
          // Used to build the wallet memo so the customer can trace this
          // SAT release to a specific NGN repayment from their wallet
          // history alone. Repayment count is bounded (one per matched
          // inflow) — no pagination concern in practice.
          repayments: { select: { amount_ngn: true } },
        },
      });

      if (!loan) {
        return { status: 'not_eligible', reason: 'loan_not_found' };
      }
      if (loan.status !== LoanStatus.REPAID) {
        return { status: 'not_eligible', reason: `status=${loan.status}` };
      }
      if (loan.collateral_released_at !== null) {
        return { status: 'already_released', reference: loan.collateral_release_reference };
      }
      if (!loan.collateral_release_address) {
        // Customer hasn't set a release address — the worker will pick it up
        // once they do (PATCH /v1/loans/:id/release-address). Not a failure;
        // just nothing to do right now.
        return { status: 'not_eligible', reason: 'no_release_address' };
      }

      const total_repaid_ngn = loan.repayments.reduce(
        (sum, r) => sum.plus(r.amount_ngn.toString()),
        new Decimal(0),
      );

      // Outside-the-tx provider call. On exception, we surface as send_failed
      // and the lock auto-expires — the worker will retry. Lock TTL is the
      // upper bound on how soon that retry can happen.
      let provider_reference: string;
      try {
        provider_reference = await this.collateral_provider.sendToLightningAddress({
          address:    loan.collateral_release_address,
          amount_sat: loan.collateral_amount_sat,
          memo:       this.buildMemo(loan.id, total_repaid_ngn),
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.logger.error(
          { loan_id: loan.id, user_id: loan.user_id, address: loan.collateral_release_address, error },
          'Collateral release: provider send failed — leaving loan eligible for retry',
        );
        await this._maybeAlertOps(loan.id, loan.user_id, loan.collateral_release_address, error);
        return { status: 'send_failed', error };
      }

      // Stamp the release atomically. The `WHERE collateral_released_at IS
      // NULL` guard inside the tx is an extra safety belt on top of the
      // Redis lock — a successful provider send + a stamped release must
      // happen together, but if a parallel attempt slipped through somehow,
      // the conditional update means only one stamp wins.
      const now = new Date();
      try {
        await this.prisma.$transaction(async (tx) => {
          const updated = await tx.loan.updateMany({
            where: { id: loan.id, collateral_released_at: null },
            data:  {
              collateral_released_at:       now,
              collateral_release_reference: provider_reference,
            },
          });
          if (updated.count === 0) {
            // Someone else stamped between our check and the update. The
            // sent SAT is real, but so is theirs (or already was). We log
            // and abort — duplicate-pay risk surfaces here, ops triage.
            throw new Error(
              `release already stamped between read-check and update (loan_id=${loan.id})`,
            );
          }
          await this.loan_status.transition(tx, {
            loan_id:      loan.id,
            user_id:      loan.user_id,
            from_status:  LoanStatus.REPAID,
            to_status:    LoanStatus.REPAID,
            triggered_by: StatusTrigger.SYSTEM,
            reason_code:  LoanReasonCodes.COLLATERAL_RELEASED,
            metadata: {
              amount_sat:         loan.collateral_amount_sat.toString(),
              provider_reference,
              release_address:    loan.collateral_release_address,
            },
          });
        });

        this.logger.log(
          {
            loan_id:    loan.id,
            user_id:    loan.user_id,
            amount_sat: loan.collateral_amount_sat.toString(),
            address:    loan.collateral_release_address,
            provider_reference,
          },
          'Collateral released',
        );
        // Clear any prior alert dedupe so a future re-release (LIQUIDATED
        // surplus on the same loan, hypothetically) starts fresh.
        await this.redis.del(REDIS_KEYS.COLLATERAL_RELEASE_ALERTED(loan.id));

        // Customer "your collateral has been released" email — fired only
        // when the stamp tx commits, so the email is sent at most once per
        // release regardless of which of the three callers (creditInflow
        // hand-off, ops endpoint, worker) won the lock. The follow-up the
        // full-repayment email promised lands here.
        await this.notifications.notifyCollateralReleased({
          loan_id:            loan.id,
          user_id:            loan.user_id,
          amount_sat:         loan.collateral_amount_sat,
          release_address:    loan.collateral_release_address,
          provider_reference,
          released_at:        now,
        });

        return { status: 'released', reference: provider_reference };
      } catch (err) {
        // Send succeeded, stamp failed. This is the dangerous case — we've
        // sent SAT but the loan row doesn't reflect it. Ops MUST investigate
        // before any retry; alert without dedupe.
        const error = err instanceof Error ? err.message : String(err);
        this.logger.error(
          { loan_id: loan.id, provider_reference, error },
          'Collateral release: provider send succeeded but DB stamp failed — manual reconciliation required',
        );
        await this.ops_alerts.alertCollateralReleaseFailed({
          loan_id:           loan.id,
          user_id:           loan.user_id,
          amount_sat:        loan.collateral_amount_sat.toString(),
          release_address:   loan.collateral_release_address,
          failure_reason:    `SEND_OK_STAMP_FAILED: ${error}`,
          provider_reference,
          alert_severity:    'critical',
        });
        return { status: 'send_failed', error };
      }
    } finally {
      // Best-effort lock release. If del fails, the TTL drops it eventually
      // — we don't want to mask the original error path.
      try { await this.redis.del(lock_key); } catch { /* swallow */ }
    }
  }

  // Per-loan, per-day rate-limited ops alert. The first failure for a loan
  // pages ops; subsequent failures within 24h are silent at the email
  // channel (the worker still logs each attempt at error level).
  private async _maybeAlertOps(
    loan_id: string,
    user_id: string,
    release_address: string,
    failure_reason: string,
  ): Promise<void> {
    const alert_key = REDIS_KEYS.COLLATERAL_RELEASE_ALERTED(loan_id);
    const set_result = await this.redis.set(
      alert_key,
      '1',
      'EX',
      RELEASE_ALERT_DEDUPE_TTL_SEC,
      'NX',
    );
    if (set_result !== 'OK') return;  // already alerted within window
    await this.ops_alerts.alertCollateralReleaseFailed({
      loan_id,
      user_id,
      release_address,
      failure_reason,
      alert_severity: 'standard',
    });
  }
}
