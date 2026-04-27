export enum KycProviderName {
  Qoreid = 'qoreid',
  Dojah = 'dojah',
  Easeid = 'easeid',
  Stub = 'stub',   // local dev only — always returns success
}

export interface KycTierConfig {
  tier1: KycProviderName;
  tier2: KycProviderName;
  tier3: KycProviderName;
}

export const KYC_TIER_CONFIG: KycTierConfig = {
  tier1: KycProviderName.Easeid,    // ← swap to Dojah / Qoreid / others in production
  tier2: KycProviderName.Qoreid,
  tier3: KycProviderName.Qoreid,
};
