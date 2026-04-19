import { Decimal } from 'decimal.js';

export const RATE_MARKUP_PERCENT       = new Decimal('0.005');  // 0.5% spread on each side
export const LOAN_LTV_PERCENT          = new Decimal('0.80');
export const LIQUIDATION_THRESHOLD     = new Decimal('1.10');
export const ALERT_THRESHOLD           = new Decimal('1.20');
export const ORIGINATION_FEE_NGN       = new Decimal('500');
export const DAILY_FEE_PER_100_NGN     = new Decimal('500');
export const MIN_LOAN_NGN              = new Decimal('50000');
export const MAX_SELFSERVE_LOAN_NGN    = new Decimal('10000000');
export const MAX_DISBURSEMENT_ACCOUNTS_PER_KIND = 5;
export const MAX_LOAN_DURATION_DAYS    = 30;
export const MIN_LOAN_DURATION_DAYS    = 1;
export const COLLATERAL_INVOICE_EXPIRY_SEC = 1800;
export const DISBURSEMENT_NAME_MATCH_THRESHOLD = 0.85;
export const PRICE_FEED_STALE_MS       = 120_000;
export const PRICE_CACHE_TTL_SEC       = 90;
export const SATS_PER_BTC              = new Decimal('100000000');
export const ALERT_COOLDOWN_SEC        = 86_400;
export const IDEMPOTENCY_TTL_SEC       = 86_400;
export const SESSION_TTL_SEC           = 86_400;

export const REDIS_KEYS = {
  PRICE: (pair: string) => `price:${pair}`,
  PRICE_STALE: 'price:stale',
  IDEMPOTENCY: (user_id: string, key: string) => `idempotency:${user_id}:${key}`,
  PAYMENT_REQUEST_PENDING: (receiving_address: string) =>
    `payment_request:pending:${receiving_address}`,
  ALERT_SENT: (loan_id: string) => `liquidation:alert_sent:${loan_id}`,
  WORKER_HEARTBEAT: (worker: string) => `worker:${worker}:last_run`,
  RATE_LIMIT_AUTH: (ip: string) => `rate_limit:auth:${ip}`,
  RATE_LIMIT_API: (user_id: string) => `rate_limit:api:${user_id}`,
} as const;

export const LoanReasonCodes = {
  LOAN_CREATED:           'LOAN_CREATED',
  COLLATERAL_CONFIRMED:   'COLLATERAL_CONFIRMED',
  DISBURSEMENT_CONFIRMED: 'DISBURSEMENT_CONFIRMED',
  REPAYMENT_RECEIVED_NGN: 'REPAYMENT_RECEIVED_NGN',
  REPAYMENT_RECEIVED_SAT: 'REPAYMENT_RECEIVED_SAT',
  COLLATERAL_RELEASED:    'COLLATERAL_RELEASED',
  LIQUIDATION_TRIGGERED:  'LIQUIDATION_TRIGGERED',
  LIQUIDATION_COMPLETED:  'LIQUIDATION_COMPLETED',
  INVOICE_EXPIRED:        'INVOICE_EXPIRED',
  CUSTOMER_CANCELLED:     'CUSTOMER_CANCELLED',
} as const;

export type LoanReasonCode = (typeof LoanReasonCodes)[keyof typeof LoanReasonCodes];
