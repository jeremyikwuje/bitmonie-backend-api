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
    [DisbursementRail.BANK_TRANSFER]: { provider: DisbursementProviderName.Palmpay },
    [DisbursementRail.MOBILE_MONEY]:  { provider: DisbursementProviderName.Stub },
  },
};

// ── Collection (inbound NGN via virtual accounts) ─────────────────────────────

export enum CollectionProviderName {
  Palmpay = 'palmpay',
}

export interface CollectionConfig {
  provider: CollectionProviderName;
}

export const COLLECTION_CONFIG: CollectionConfig = {
  provider: CollectionProviderName.Palmpay,
};
