import { Decimal } from 'decimal.js';

export const RATE_MARKUP_PERCENT       = new Decimal('0.005');  // 0.5% spread on each side
export const LOAN_LTV_PERCENT          = new Decimal('0.60');
export const LIQUIDATION_THRESHOLD     = new Decimal('1.10');
export const ALERT_THRESHOLD           = new Decimal('1.20');

// Sanity floor for the liquidation monitor: a current SAT/NGN rate below this
// fraction of the loan's `sat_ngn_rate_at_creation` is treated as a likely
// feed glitch — the cycle skips liquidation and pages ops instead of seizing
// collateral on a bad price. Default 0.5 (i.e. > 50% drop since origination).
export const MIN_LIQUIDATION_RATE_FRACTION = new Decimal('0.5');

// ── Fee model (v1.1 — accrual-based) ────────────────────────────────────────
// See docs/repayment-matching-redesign.md §1, §3, §4.
//
// Origination:  ceil(principal_ngn / 100_000) × 500          — one-time, upfront
// Interest:     0.3% daily on outstanding principal           — simple, non-compounding
// Custody:      ceil(initial_collateral_usd / 100) × 100      — fixed at origination, per day
export const ORIGINATION_FEE_PER_100K_NGN = new Decimal('500');
export const DAILY_INTEREST_RATE_BPS      = 30;                    // 30 bps = 0.3%
export const CUSTODY_FEE_PER_100_USD_NGN  = new Decimal('100');

export const MIN_LOAN_NGN              = new Decimal('10000');
export const MAX_SELFSERVE_LOAN_NGN    = new Decimal('10000000');
export const MIN_PARTIAL_REPAYMENT_NGN = new Decimal('10000');

export const MAX_DISBURSEMENT_ACCOUNTS_PER_KIND = 5;
export const MAX_LOAN_DURATION_DAYS    = 90;
export const MIN_LOAN_DURATION_DAYS    = 1;
export const LOAN_GRACE_PERIOD_DAYS    = 7;

export const COLLATERAL_INVOICE_EXPIRY_SEC = 1800;
export const COLLATERAL_TOPUP_EXPIRY_SEC   = 1800;
// Threshold for the outflow reconciler worker — Outflows that stay PROCESSING
// past this many seconds get probed via DisbursementProvider.getTransferStatus
// to recover from lost provider webhooks. Real provider webhooks usually
// arrive within seconds; 5 minutes is generous enough to not race the happy
// path while still bounding customer-visible delay.
export const OUTFLOW_PROCESSING_STALE_SEC  = 300;
export const DISBURSEMENT_NAME_MATCH_THRESHOLD = 0.85;
export const PRICE_FEED_STALE_MS       = 120_000;
export const PRICE_CACHE_TTL_SEC       = 90;
export const SATS_PER_BTC              = new Decimal('100000000');
export const ALERT_COOLDOWN_SEC        = 86_400;
export const IDEMPOTENCY_TTL_SEC       = 86_400;
export const SESSION_TTL_SEC           = 86_400;
export const OPS_SESSION_TTL_SEC       = 28_800;       // 8h fixed, no sliding (docs/ops-module.md §9)
export const OPS_CHALLENGE_TTL_SEC     = 300;          // 5min — login → verify-2fa window
export const OPS_ENROLMENT_TTL_SEC     = 900;          // 15min — login → enrol-2fa window
export const WEBHOOK_LOG_RETENTION_DAYS = 90;          // webhook_logs older than this get pruned by the scheduler

export const REDIS_KEYS = {
  PRICE: (pair: string) => `price:${pair}`,
  PRICE_STALE: 'price:stale',
  IDEMPOTENCY: (user_id: string, key: string) => `idempotency:${user_id}:${key}`,
  PAYMENT_REQUEST_PENDING: (receiving_address: string) =>
    `payment_request:pending:${receiving_address}`,
  COLLATERAL_TOPUP_PENDING: (receiving_address: string) =>
    `collateral_topup:pending:${receiving_address}`,
  ALERT_SENT: (loan_id: string) => `liquidation:alert_sent:${loan_id}`,
  REMINDER_SENT: (loan_id: string, slot: string) => `reminder_sent:${loan_id}:${slot}`,
  WORKER_HEARTBEAT: (worker: string) => `worker:${worker}:last_run`,
  RATE_LIMIT_AUTH: (ip: string) => `rate_limit:auth:${ip}`,
  RATE_LIMIT_API: (user_id: string) => `rate_limit:api:${user_id}`,
  OPS_CHALLENGE: (challenge_id: string) => `ops_auth:challenge:${challenge_id}`,
  OPS_ENROLMENT: (enrolment_token: string) => `ops_auth:enrolment:${enrolment_token}`,
} as const;

export const LoanReasonCodes = {
  LOAN_CREATED:                  'LOAN_CREATED',
  COLLATERAL_CONFIRMED:          'COLLATERAL_CONFIRMED',
  DISBURSEMENT_CONFIRMED:        'DISBURSEMENT_CONFIRMED',
  REPAYMENT_PARTIAL_NGN:         'REPAYMENT_PARTIAL_NGN',
  REPAYMENT_COMPLETED:           'REPAYMENT_COMPLETED',
  COLLATERAL_TOPPED_UP:          'COLLATERAL_TOPPED_UP',
  COLLATERAL_RELEASED:           'COLLATERAL_RELEASED',
  LIQUIDATION_TRIGGERED:         'LIQUIDATION_TRIGGERED',
  LIQUIDATION_COMPLETED:         'LIQUIDATION_COMPLETED',
  LIQUIDATION_REVERSED_BAD_RATE: 'LIQUIDATION_REVERSED_BAD_RATE',
  MATURITY_GRACE_STARTED:        'MATURITY_GRACE_STARTED',
  MATURITY_GRACE_EXPIRED:        'MATURITY_GRACE_EXPIRED',
  INVOICE_EXPIRED:               'INVOICE_EXPIRED',
  CUSTOMER_CANCELLED:            'CUSTOMER_CANCELLED',
} as const;

export type LoanReasonCode = (typeof LoanReasonCodes)[keyof typeof LoanReasonCodes];
