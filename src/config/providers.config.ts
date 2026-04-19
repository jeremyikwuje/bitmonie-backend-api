import { registerAs } from '@nestjs/config';

export interface PriceFeedProviderConfig {
  api_key: string;
  base_url: string;
}

export interface CollateralProviderConfig {
  api_key: string;
  base_url: string;
  webhook_secret: string;
}

export interface DisbursementProviderConfig {
  api_key: string;
  secret_key: string;
  base_url: string;
  webhook_secret: string;
  webhook_ip_allowlist: string[];
}

export interface KycProviderConfig {
  client_id: string;
  client_secret: string;
  base_url: string;
}

export interface ProvidersConfig {
  price_feed: PriceFeedProviderConfig;
  collateral: CollateralProviderConfig;
  disbursement: DisbursementProviderConfig;
  kyc: KycProviderConfig;
}

const splitCsv = (raw?: string): string[] =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

export default registerAs('providers', (): ProvidersConfig => ({
  price_feed: {
    api_key: process.env.MONIERATE_API_KEY ?? '',
    base_url: process.env.MONIERATE_BASE_URL ?? 'https://api.monierate.com',
  },
  collateral: {
    api_key: process.env.COLLATERAL_PROVIDER_API_KEY ?? '',
    base_url: process.env.COLLATERAL_PROVIDER_BASE_URL ?? '',
    webhook_secret: process.env.COLLATERAL_PROVIDER_WEBHOOK_SECRET ?? '',
  },
  disbursement: {
    api_key: process.env.DISBURSEMENT_PROVIDER_API_KEY ?? '',
    secret_key: process.env.DISBURSEMENT_PROVIDER_SECRET_KEY ?? '',
    base_url: process.env.DISBURSEMENT_PROVIDER_BASE_URL ?? '',
    webhook_secret: process.env.DISBURSEMENT_PROVIDER_WEBHOOK_SECRET ?? '',
    webhook_ip_allowlist: splitCsv(process.env.DISBURSEMENT_PROVIDER_WEBHOOK_IP_ALLOWLIST),
  },
  kyc: {
    client_id: process.env.KYC_PROVIDER_CLIENT_ID ?? '',
    client_secret: process.env.KYC_PROVIDER_CLIENT_SECRET ?? '',
    base_url: process.env.KYC_PROVIDER_BASE_URL ?? '',
  },
}));
