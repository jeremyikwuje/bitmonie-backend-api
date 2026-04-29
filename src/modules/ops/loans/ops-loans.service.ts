import { Inject, Injectable } from '@nestjs/common';
import { LoanStatus, StatusTrigger } from '@prisma/client';
import Decimal from 'decimal.js';
import type Redis from 'ioredis';
import { PrismaService } from '@/database/prisma.service';
import { REDIS_CLIENT } from '@/database/redis.module';
import { OpsAuditService } from '@/modules/ops/auth/ops-audit.service';
import { OPS_ACTION, OPS_TARGET_TYPE } from '@/common/constants/ops-actions';
import {
  LoanReasonCodes,
  MIN_LIQUIDATION_RATE_FRACTION,
  REDIS_KEYS,
} from '@/common/constants';
import {
  LoanNotFoundException,
  LoanNotLiquidatedException,
  LiquidationNotBadRateException,
} from '@/common/errors/bitmonie.errors';
import {
  REMINDER_SLOTS,
  determineCurrentSlot,
  type ReminderSlot,
} from '@/modules/loans/reminder-templates';
import type { OpsAuditContext } from '@/modules/ops/disbursements/ops-disbursements.service';

// Healthy = heartbeat is no older than 2× the worker tick interval. The default
// loan-reminder tick is 1h, so >2h with no heartbeat means the scheduler is
// down (or the loan-reminder cycle is throwing pre-heartbeat). Kept generous
// so a single missed tick doesn't trip false alarms.
const REMINDER_HEARTBEAT_HEALTHY_MS = 2 * 60 * 60 * 1000;

// Reverses a LIQUIDATED loan back to ACTIVE when the liquidation was triggered
// by a glitched price feed (`liquidation_rate_actual < sat_ngn_rate_at_creation
// × MIN_LIQUIDATION_RATE_FRACTION`). This is the *only* place LIQUIDATED → ACTIVE
// is permitted; CLAUDE.md §5.4 forbids backward transitions everywhere else, so
// this service writes the loan update + status log + audit row directly in one
// Prisma transaction rather than going through LoanStatusService (which would
// reject the transition).
//
// The bad-rate signature is verified server-side — ops cannot restore an
// arbitrary liquidation. If the liquidation rate is plausibly market-driven
// (≥ sanity floor), the request is refused with LIQUIDATION_NOT_BAD_RATE.
//
// Note: an in-flight or already-completed `BlinkProvider.swapBtcToUsd` against
// the seized BTC is NOT unwound by this endpoint — that swap runs after the
// liquidation tx commits and is fire-and-forget. Ops must square Bitmonie's
// internal wallet position separately. The customer-facing loan record is whole
// regardless.
export interface ReminderSlotStatus {
  slot:           ReminderSlot;
  dedup_present:  boolean;     // Redis key reminder_sent:{loan_id}:{slot} exists
  ttl_seconds:    number | null; // remaining TTL on the dedup key, null when absent
}

export interface ReminderHeartbeat {
  last_run_at:    Date;
  age_seconds:    number;
  healthy:        boolean; // true when age ≤ 2× the worker tick interval
}

export interface LoanRemindersDiagnostic {
  loan_id:           string;
  due_at:            Date;
  now:               Date;
  hours_from_due:    number;
  expected_slot:     ReminderSlot | null; // what determineCurrentSlot would return right now
  worker_heartbeat:  ReminderHeartbeat | null; // null when the worker has never written one
  slots:             ReminderSlotStatus[];     // every known slot, in chronological order
}

@Injectable()
export class OpsLoansService {
  constructor(
    private readonly prisma:    PrismaService,
    private readonly ops_audit: OpsAuditService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  // Read-only diagnostic. Lets ops answer "did the reminder for this loan
  // fire?" without poking at Redis directly. Returns the current expected
  // slot, the per-slot dedup-key state, and the worker heartbeat — enough
  // to disambiguate "worker is down" from "worker ran but skipped" from
  // "reminder was sent but bounced upstream". No audit row written —
  // mirrors the read-only ops list endpoints.
  async getReminders(loan_id: string): Promise<LoanRemindersDiagnostic> {
    const loan = await this.prisma.loan.findUnique({
      where:  { id: loan_id },
      select: { id: true, due_at: true },
    });
    if (!loan) throw new LoanNotFoundException();

    const now = new Date();
    const hours_from_due = (now.getTime() - loan.due_at.getTime()) / 3_600_000;

    // Pipeline so the Redis round-trip is one network hop, not 11.
    const pipeline = this.redis.pipeline();
    pipeline.get(REDIS_KEYS.WORKER_HEARTBEAT('loan_reminder'));
    for (const { slot } of REMINDER_SLOTS) {
      pipeline.exists(REDIS_KEYS.REMINDER_SENT(loan.id, slot));
      pipeline.ttl(REDIS_KEYS.REMINDER_SENT(loan.id, slot));
    }
    const replies = await pipeline.exec();

    const heartbeat_raw = replies?.[0]?.[1] as string | null | undefined;
    const worker_heartbeat = parseHeartbeat(heartbeat_raw, now);

    const slots: ReminderSlotStatus[] = REMINDER_SLOTS.map(({ slot }, i) => {
      const exists_reply = replies?.[1 + i * 2]?.[1] as number | undefined;
      const ttl_reply    = replies?.[2 + i * 2]?.[1] as number | undefined;
      const dedup_present = exists_reply === 1;
      // ioredis returns -1 (no TTL) and -2 (key missing). Map both to null
      // for the wire shape so the client never has to know Redis sentinels.
      const ttl_seconds =
        dedup_present && typeof ttl_reply === 'number' && ttl_reply >= 0
          ? ttl_reply
          : null;
      return { slot, dedup_present, ttl_seconds };
    });

    return {
      loan_id:          loan.id,
      due_at:           loan.due_at,
      now,
      hours_from_due,
      expected_slot:    determineCurrentSlot(loan.due_at, now),
      worker_heartbeat,
      slots,
    };
  }

  async restoreFromBadLiquidation(
    loan_id: string,
    reason:  string,
    ctx:     OpsAuditContext,
  ): Promise<void> {
    const loan = await this.prisma.loan.findUnique({
      where:  { id: loan_id },
      select: {
        id:                       true,
        user_id:                  true,
        status:                   true,
        liquidated_at:            true,
        liquidation_rate_actual:  true,
        sat_ngn_rate_at_creation: true,
      },
    });
    if (!loan) throw new LoanNotFoundException();

    if (loan.status !== LoanStatus.LIQUIDATED) {
      throw new LoanNotLiquidatedException({ status: loan.status });
    }

    const rate_at_creation = new Decimal(loan.sat_ngn_rate_at_creation.toString());
    const sanity_floor     = rate_at_creation.mul(MIN_LIQUIDATION_RATE_FRACTION);
    const actual_rate      = loan.liquidation_rate_actual
      ? new Decimal(loan.liquidation_rate_actual.toString())
      : null;

    // Bad-rate signature: rate at liquidation must be present and below the
    // per-loan sanity floor. A null rate counts as bad — the worker stamped
    // it as part of the same broken-feed cascade.
    const is_bad_rate = actual_rate === null || actual_rate.lt(sanity_floor);
    if (!is_bad_rate) {
      throw new LiquidationNotBadRateException({
        liquidation_rate_actual:  actual_rate ? actual_rate.toFixed(6) : null,
        sat_ngn_rate_at_creation: rate_at_creation.toFixed(6),
        sanity_floor:             sanity_floor.toFixed(6),
      });
    }

    await this.prisma.$transaction(async (tx) => {
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
          loan_id:        loan.id,
          user_id:        loan.user_id,
          from_status:    LoanStatus.LIQUIDATED,
          to_status:      LoanStatus.ACTIVE,
          triggered_by:   StatusTrigger.SYSTEM,
          triggered_by_id: ctx.ops_user_id,
          reason_code:    LoanReasonCodes.LIQUIDATION_REVERSED_BAD_RATE,
          reason_detail:  reason,
          metadata: {
            original_liquidation_rate_actual: actual_rate ? actual_rate.toString() : null,
            original_liquidated_at:           loan.liquidated_at?.toISOString() ?? null,
            sat_ngn_rate_at_creation:         rate_at_creation.toString(),
            min_liquidation_rate_fraction:    MIN_LIQUIDATION_RATE_FRACTION.toString(),
          },
        },
      });

      await this.ops_audit.write(tx, {
        ops_user_id: ctx.ops_user_id,
        action:      OPS_ACTION.LOAN_RESTORE_BAD_LIQUIDATION,
        target_type: OPS_TARGET_TYPE.LOAN,
        target_id:   loan.id,
        details: {
          previous_status:                 loan.status,
          original_liquidation_rate_actual: actual_rate ? actual_rate.toString() : null,
          original_liquidated_at:          loan.liquidated_at?.toISOString() ?? null,
          sanity_floor:                    sanity_floor.toFixed(6),
          reason,
        },
        request_id:  ctx.request_id,
        ip_address:  ctx.ip_address,
      });
    });
  }
}

// Parses the worker_heartbeat:loan_reminder Redis value (epoch ms as string,
// what the worker writes via `Date.now().toString()`). A missing key, an
// empty string, or anything that doesn't parse to a positive integer
// produces null — interpreted as "the worker has never written a heartbeat
// in this Redis instance," which most often means the scheduler isn't
// running yet.
function parseHeartbeat(raw: string | null | undefined, now: Date): ReminderHeartbeat | null {
  if (!raw) return null;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const age_ms = now.getTime() - ms;
  return {
    last_run_at: new Date(ms),
    age_seconds: Math.floor(age_ms / 1000),
    healthy:     age_ms <= REMINDER_HEARTBEAT_HEALTHY_MS,
  };
}
