import { DisbursementRail } from '@prisma/client';

export enum DisbursementProviderName {
  Palmpay = 'palmpay',
  Stub    = 'stub',   // local dev only — always returns success + matches any name
}

export interface DisbursementRailConfig {
  provider: DisbursementProviderName;
}

export interface DisbursementRoutesConfig {
  NGN: Partial<Record<DisbursementRail, DisbursementRailConfig>>;
}

export const DISBURSEMENT_ROUTES_CONFIG: DisbursementRoutesConfig = {
  NGN: {
    [DisbursementRail.BANK_TRANSFER]: { provider: DisbursementProviderName.Stub },
    [DisbursementRail.MOBILE_MONEY]:  { provider: DisbursementProviderName.Stub },
  },
};
