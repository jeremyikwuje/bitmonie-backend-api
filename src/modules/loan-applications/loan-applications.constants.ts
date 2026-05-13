import { LoanApplicationCollateralType } from '@prisma/client';

// Display strings shared with the landing page. The form submits these exact
// strings; we map them to the Prisma enum on persistence. Keep in sync with
// `bitmonie-web` and docs/loan-applications.md §2.3.
export const LOAN_APPLICATION_COLLATERAL_DISPLAYS = [
  'Bitcoin (BTC)',
  'USDT / USDC',
  'MacBook (M1 or newer)',
  'iPhone (13 or newer)',
  'Car (2008 or newer)',
] as const;

export type LoanApplicationCollateralDisplay =
  (typeof LOAN_APPLICATION_COLLATERAL_DISPLAYS)[number];

export const COLLATERAL_DISPLAY_TO_ENUM: Record<
  LoanApplicationCollateralDisplay,
  LoanApplicationCollateralType
> = {
  'Bitcoin (BTC)':         LoanApplicationCollateralType.BITCOIN,
  'USDT / USDC':           LoanApplicationCollateralType.USDT_USDC,
  'MacBook (M1 or newer)': LoanApplicationCollateralType.MACBOOK_M1_OR_NEWER,
  'iPhone (13 or newer)':  LoanApplicationCollateralType.IPHONE_13_OR_NEWER,
  'Car (2008 or newer)':   LoanApplicationCollateralType.CAR_2008_OR_NEWER,
};

export const COLLATERAL_ENUM_TO_DISPLAY: Record<
  LoanApplicationCollateralType,
  LoanApplicationCollateralDisplay
> = {
  [LoanApplicationCollateralType.BITCOIN]:             'Bitcoin (BTC)',
  [LoanApplicationCollateralType.USDT_USDC]:           'USDT / USDC',
  [LoanApplicationCollateralType.MACBOOK_M1_OR_NEWER]: 'MacBook (M1 or newer)',
  [LoanApplicationCollateralType.IPHONE_13_OR_NEWER]:  'iPhone (13 or newer)',
  [LoanApplicationCollateralType.CAR_2008_OR_NEWER]:   'Car (2008 or newer)',
};

// Bot-trap thresholds. See docs/loan-applications.md §6.2.
export const LOAN_APPLICATION_FILL_TIME_FLOOR_MS = 1_500;
export const LOAN_APPLICATION_FILL_TIME_MAX_AGE_MS = 86_400_000; // 24h

// Per-IP rate limit. See docs/loan-applications.md §6.3.
export const LOAN_APPLICATION_THROTTLE_TTL_MS = 3_600_000;       // 1h window
export const LOAN_APPLICATION_THROTTLE_LIMIT = 5;
