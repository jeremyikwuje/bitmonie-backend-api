import { registerAs } from '@nestjs/config';

// ── Selector — which concrete provider is active for each role ────────────────
export interface ActiveProviders {
  price_feed: string;   // 'quidax'
  collateral: string;   // 'blink'
  disbursement: string; // 'palmpay' | 'opay'
  kyc: string;          // 'qoreid'
}

// ── Per-provider credential shapes ───────────────────────────────────────────
export interface QuidaxConfig {
  api_key: string;
  base_url: string;
}

export interface BlinkConfig {
  api_key: string;
  base_url: string;
  webhook_secret: string;
}

export interface PalmpayConfig {
  api_key: string;
  secret_key: string;
  base_url: string;
  webhook_secret: string;
  webhook_ip_allowlist: string[];
}

export interface QoreidConfig {
  client_id: string;
  client_secret: string;
  base_url: string;
}

// ── Aggregate config ──────────────────────────────────────────────────────────
export interface ProvidersConfig {
  active: ActiveProviders;
  quidax: QuidaxConfig;
  blink: BlinkConfig;
  palmpay: PalmpayConfig;
  qoreid: QoreidConfig;
}

const splitCsv = (raw?: string): string[] =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

export default registerAs('providers', (): ProvidersConfig => ({
  active: {
    price_feed:   process.env.PRICE_FEED_PROVIDER   ?? 'quidax',
    collateral:   process.env.COLLATERAL_PROVIDER   ?? 'blink',
    disbursement: process.env.DISBURSEMENT_PROVIDER ?? 'palmpay',
    kyc:          process.env.KYC_PROVIDER          ?? 'qoreid',
  },
  quidax: {
    api_key:  process.env.QUIDAX_API_KEY  ?? '',
    base_url: process.env.QUIDAX_BASE_URL ?? 'https://app.quidax.io/api/v1',
  },
  blink: {
    api_key:        process.env.BLINK_API_KEY        ?? '',
    base_url:       process.env.BLINK_BASE_URL        ?? 'https://api.blink.sv',
    webhook_secret: process.env.BLINK_WEBHOOK_SECRET  ?? '',
  },
  palmpay: {
    api_key:              process.env.PALMPAY_API_KEY              ?? '',
    secret_key:           process.env.PALMPAY_SECRET_KEY           ?? '',
    base_url:             process.env.PALMPAY_BASE_URL             ?? '',
    webhook_secret:       process.env.PALMPAY_WEBHOOK_SECRET       ?? '',
    webhook_ip_allowlist: splitCsv(process.env.PALMPAY_WEBHOOK_IP_ALLOWLIST),
  },
  qoreid: {
    client_id:     process.env.QOREID_CLIENT_ID     ?? '',
    client_secret: process.env.QOREID_CLIENT_SECRET ?? '',
    base_url:      process.env.QOREID_BASE_URL      ?? '',
  },
}));
