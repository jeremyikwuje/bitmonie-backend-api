import { BadRequestException, Injectable } from '@nestjs/common';
import { LoanStatus } from '@prisma/client';
import Decimal from 'decimal.js';
import { PrismaService } from '@/database/prisma.service';
import { LoanReasonCodes } from '@/common/constants';
import { displayNgn } from '@/common/formatting/ngn-display';
import {
  type ActivityType,
  type ActivityItemDto,
  type ActivityPageResponseDto,
} from './dto/activity-page-response.dto';

// ─────────────────────────────────────────────────────────────────────────────
// ActivityService — read-only money-movement feed for the web client.
// Sources (per docs/web.md §5.2):
//   - loan_status_logs   → everything except INFLOW_RECEIVED_UNMATCHED
//   - inflows (unmatched)→ INFLOW_RECEIVED_UNMATCHED only
// Auth events (login, password change, 2FA toggle) are deliberately excluded.
//
// Cursor format: base64(occurred_at_iso || '|' || stable_id) where stable_id
// is prefixed with the source ('log:' or 'inflow:') so cursors are unambiguous
// across the union.
// ─────────────────────────────────────────────────────────────────────────────

const REASON_TO_TYPE: Partial<Record<string, ActivityType>> = {
  [LoanReasonCodes.LOAN_CREATED]:           'LOAN_CREATED',
  [LoanReasonCodes.COLLATERAL_CONFIRMED]:   'COLLATERAL_RECEIVED',
  [LoanReasonCodes.COLLATERAL_TOPPED_UP]:   'COLLATERAL_TOPPED_UP',
  [LoanReasonCodes.DISBURSEMENT_CONFIRMED]: 'LOAN_DISBURSED',
  [LoanReasonCodes.REPAYMENT_PARTIAL_NGN]:  'REPAYMENT_RECEIVED',
  [LoanReasonCodes.REPAYMENT_COMPLETED]:    'LOAN_REPAID',
  [LoanReasonCodes.COLLATERAL_RELEASED]:    'COLLATERAL_RELEASED',
  [LoanReasonCodes.LIQUIDATION_TRIGGERED]:  'LOAN_LIQUIDATED',
  [LoanReasonCodes.INVOICE_EXPIRED]:        'LOAN_EXPIRED',
  [LoanReasonCodes.CUSTOMER_CANCELLED]:     'LOAN_CANCELLED',
  // Deliberately omitted: LIQUIDATION_COMPLETED, LIQUIDATION_REVERSED_BAD_RATE,
  // MATURITY_GRACE_STARTED, MATURITY_GRACE_EXPIRED — these are internal /
  // duplicative of user-visible types above.
};

const UNTRUSTED_UNMATCHED_REASONS = new Set([
  'requery_mismatch',
  'requery_unconfirmed',
  'credit_failed',
]);

interface DecodedCursor {
  occurred_at: Date;
  source: 'log' | 'inflow';
  id: string;
}

@Injectable()
export class ActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async getPage(
    user_id: string,
    raw_cursor: string | undefined,
    limit: number,
  ): Promise<ActivityPageResponseDto> {
    const cursor = raw_cursor ? this.decodeCursor(raw_cursor) : null;

    // Pull `limit` candidates from each source. Worst-case interleaving means
    // we may discard up to `limit` rows from one source per page; over-fetching
    // here keeps subsequent pages strictly correct.
    const cursor_or = cursor
      ? {
          OR: [
            { created_at: { lt: cursor.occurred_at } },
            { created_at: cursor.occurred_at, id: { lt: cursor.id } },
          ],
        }
      : {};

    const [log_rows, inflow_rows] = await Promise.all([
      this.prisma.loanStatusLog.findMany({
        where: {
          user_id,
          reason_code: { in: Object.keys(REASON_TO_TYPE) },
          ...cursor_or,
        },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: limit,
        include: {
          loan: {
            select: {
              id: true,
              principal_ngn: true,
              collateral_amount_sat: true,
              disbursement_account: {
                select: { provider_name: true, account_unique: true },
              },
            },
          },
        },
      }),
      this.prisma.inflow.findMany({
        where: {
          user_id,
          currency: 'NGN',
          is_matched: false,
          source_type: null,
          ...cursor_or,
        },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: limit,
      }),
    ]);

    // Map to common shape, then merge + sort + slice.
    const log_items: ActivityItemDto[] = [];
    for (const row of log_rows) {
      const type = REASON_TO_TYPE[row.reason_code];
      if (!type) continue; // belt-and-braces — `where.reason_code.in` should already filter
      log_items.push(this.buildLogItem(row, type));
    }

    const inflow_items: ActivityItemDto[] = inflow_rows
      .filter((row) => {
        const reason = (row.provider_response as { bitmonie_unmatched_reason?: string } | null)
          ?.bitmonie_unmatched_reason;
        return !reason || !UNTRUSTED_UNMATCHED_REASONS.has(reason);
      })
      .map((row) => this.buildInflowItem(row));

    const merged = [...log_items, ...inflow_items].sort((a, b) => {
      const t = b.occurred_at.localeCompare(a.occurred_at);
      if (t !== 0) return t;
      return b.id.localeCompare(a.id);
    });

    const page = merged.slice(0, limit);

    // Emit a cursor whenever there might be more — either we trimmed merged
    // (more candidates than fit in this page) OR a source returned exactly
    // its limit (it could have older rows we haven't seen yet).
    const has_more =
      merged.length > limit ||
      log_rows.length === limit ||
      inflow_rows.length === limit;
    const next_cursor =
      has_more && page.length > 0 ? this.encodeCursorFromItem(page[page.length - 1]) : null;

    return { items: page, next_cursor };
  }

  // ─── cursor helpers ───────────────────────────────────────────────────────

  private encodeCursorFromItem(item: ActivityItemDto): string {
    // item.id was minted as `${source}:${row_id}` — split once, no further parsing.
    const sep = item.id.indexOf(':');
    const source = item.id.slice(0, sep);
    const id = item.id.slice(sep + 1);
    return Buffer.from(`${item.occurred_at}|${source}|${id}`, 'utf8').toString('base64url');
  }

  private decodeCursor(raw: string): DecodedCursor {
    let decoded: string;
    try {
      decoded = Buffer.from(raw, 'base64url').toString('utf8');
    } catch {
      throw new BadRequestException('Malformed cursor');
    }
    const [iso, source, id] = decoded.split('|');
    const ts = iso ? Date.parse(iso) : NaN;
    if (Number.isNaN(ts) || (source !== 'log' && source !== 'inflow') || !id) {
      throw new BadRequestException('Malformed cursor');
    }
    return { occurred_at: new Date(ts), source, id };
  }

  // ─── row → ActivityItemDto ────────────────────────────────────────────────

  private buildLogItem(
    row: {
      id: string;
      created_at: Date;
      reason_code: string;
      to_status: LoanStatus;
      metadata: unknown;
      loan: {
        id: string;
        principal_ngn: { toString: () => string };
        collateral_amount_sat: bigint;
        disbursement_account: { provider_name: string; account_unique: string } | null;
      } | null;
    },
    type: ActivityType,
  ): ActivityItemDto {
    const loan_id = row.loan?.id;
    const loan_short = loan_id ? loan_id.slice(0, 8) : null;
    const principal = row.loan ? new Decimal(row.loan.principal_ngn.toString()) : null;
    const meta = (row.metadata as Record<string, unknown> | null) ?? {};

    let title = '';
    let subtitle: string | undefined;
    let amount_ngn: string | undefined;
    let amount_sat: string | undefined;

    switch (type) {
      case 'LOAN_CREATED':
        title = principal ? `${formatNgn(principal)} loan started` : 'Loan started';
        subtitle = 'Awaiting collateral';
        amount_ngn = principal ? displayNgn(principal, 'ceil') : undefined;
        break;
      case 'COLLATERAL_RECEIVED':
        title = row.loan
          ? `${formatSat(row.loan.collateral_amount_sat)} SAT collateral received`
          : 'Collateral received';
        subtitle = loan_short ? `Loan #${loan_short}` : undefined;
        amount_sat = row.loan ? row.loan.collateral_amount_sat.toString() : undefined;
        break;
      case 'COLLATERAL_TOPPED_UP': {
        const top_up_sat = readBigInt(meta.amount_sat) ?? readBigInt(meta.top_up_sat);
        title = top_up_sat
          ? `${formatSat(top_up_sat)} SAT added to collateral`
          : 'Collateral topped up';
        subtitle = loan_short ? `Loan #${loan_short}` : undefined;
        amount_sat = top_up_sat?.toString();
        break;
      }
      case 'LOAN_DISBURSED': {
        const acct = row.loan?.disbursement_account;
        const where = acct ? `to ${acct.provider_name} ${maskAccount(acct.account_unique)}` : '';
        title = principal ? `${formatNgn(principal)} sent ${where}`.trim() : 'Loan disbursed';
        subtitle = loan_short ? `Loan #${loan_short}` : undefined;
        amount_ngn = principal ? displayNgn(principal, 'floor') : undefined; // we paid → floor
        break;
      }
      case 'REPAYMENT_RECEIVED': {
        const applied = sumApplied(meta);
        title = applied
          ? `${formatNgn(applied)} repayment received`
          : 'Repayment received';
        subtitle = loan_short
          ? `Loan #${loan_short} — partial repayment`
          : 'Partial repayment';
        amount_ngn = applied ? displayNgn(applied, 'ceil') : undefined;
        break;
      }
      case 'LOAN_REPAID': {
        const applied = sumApplied(meta);
        title = loan_short ? `Loan #${loan_short} fully repaid` : 'Loan fully repaid';
        subtitle = applied ? `Final payment ${formatNgn(applied)}` : undefined;
        amount_ngn = applied ? displayNgn(applied, 'ceil') : undefined;
        break;
      }
      case 'COLLATERAL_RELEASED':
        title = row.loan
          ? `${formatSat(row.loan.collateral_amount_sat)} SAT returned`
          : 'Collateral returned';
        subtitle = 'Sent to your address';
        amount_sat = row.loan ? row.loan.collateral_amount_sat.toString() : undefined;
        break;
      case 'LOAN_LIQUIDATED':
        title = loan_short ? `Loan #${loan_short} liquidated` : 'Loan liquidated';
        subtitle = 'Collateral seized to cover outstanding';
        break;
      case 'LOAN_EXPIRED':
        title = loan_short ? `Loan #${loan_short} expired` : 'Loan expired';
        subtitle = "Collateral wasn't paid in time";
        break;
      case 'LOAN_CANCELLED':
        title = loan_short ? `Loan #${loan_short} cancelled` : 'Loan cancelled';
        subtitle = 'Cancelled by you';
        break;
      default:
        title = type;
    }

    return {
      id: `log:${row.id}`,
      occurred_at: row.created_at.toISOString(),
      type,
      title,
      subtitle,
      amount_ngn,
      amount_sat,
      loan_id,
      link: loan_id ? `/loans/${loan_id}` : undefined,
    };
  }

  private buildInflowItem(row: {
    id: string;
    created_at: Date;
    amount: { toString: () => string };
  }): ActivityItemDto {
    const amount = new Decimal(row.amount.toString());
    return {
      id: `inflow:${row.id}`,
      occurred_at: row.created_at.toISOString(),
      type: 'INFLOW_RECEIVED_UNMATCHED',
      title: `${formatNgn(amount)} received — needs matching`,
      subtitle: 'Tap to apply to a loan',
      amount_ngn: displayNgn(amount, 'ceil'),
      link: '/inflows',
    };
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function formatNgn(amount: Decimal): string {
  const whole = displayNgn(amount, 'ceil');
  const with_commas = Number(whole).toLocaleString('en-NG');
  return `₦${with_commas}`;
}

function formatSat(amount_sat: bigint): string {
  return amount_sat.toLocaleString('en-US');
}

function maskAccount(account_unique: string): string {
  if (account_unique.length <= 4) return `****${account_unique}`;
  return `****${account_unique.slice(-4)}`;
}

function sumApplied(meta: Record<string, unknown>): Decimal | null {
  const principal = readDecimal(meta.applied_to_principal);
  const interest = readDecimal(meta.applied_to_interest);
  const custody = readDecimal(meta.applied_to_custody);
  if (!principal && !interest && !custody) return null;
  return (principal ?? new Decimal(0))
    .plus(interest ?? new Decimal(0))
    .plus(custody ?? new Decimal(0));
}

function readDecimal(value: unknown): Decimal | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return new Decimal(value);
  if (typeof value === 'string') {
    try { return new Decimal(value); } catch { return null; }
  }
  return null;
}

function readBigInt(value: unknown): bigint | null {
  if (typeof value === 'string') {
    try { return BigInt(value); } catch { return null; }
  }
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  return null;
}
