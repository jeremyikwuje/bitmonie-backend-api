import { registerAs } from '@nestjs/config';

// ── Selector — which concrete provider is active for each role ────────────────
export interface ActiveProviders {
  price_feed: string;   // 'quidax'
  collateral: string;   // 'blink'
  disbursement: string; // 'palmpay' | 'opay'
  kyc: string;          // 'qoreid'
  email: string;        // 'mailgun' | 'resend' | 'postmark'
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

export interface MailgunConfig {
  api_key: string;
  domain: string;
  region: 'us' | 'eu';   // determines which base URL the provider uses
  from_address: string;
  from_name: string;
}

export interface ResendConfig {
  api_key: string;
  from_address: string;
  from_name: string;
}

export interface PostmarkConfig {
  server_token: string;
  from_address: string;
  from_name: string;
  message_stream?: string;
}

// ── Aggregate config ──────────────────────────────────────────────────────────
export interface ProvidersConfig {
  active: ActiveProviders;
  quidax: QuidaxConfig;
  blink: BlinkConfig;
  palmpay: PalmpayConfig;
  qoreid: QoreidConfig;
  mailgun: MailgunConfig;
  resend: ResendConfig;
  postmark: PostmarkConfig;
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
    email:        process.env.EMAIL_PROVIDER        ?? 'resend',
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
  mailgun: {
    api_key:      process.env.MAILGUN_API_KEY      ?? '',
    domain:       process.env.MAILGUN_DOMAIN       ?? '',
    region:       (process.env.MAILGUN_REGION ?? 'eu') as 'us' | 'eu',
    from_address: process.env.EMAIL_FROM_ADDRESS   ?? '',
    from_name:    process.env.EMAIL_FROM_NAME      ?? 'Bitmonie',
  },
  resend: {
    api_key:      process.env.RESEND_API_KEY       ?? '',
    from_address: process.env.EMAIL_FROM_ADDRESS   ?? '',
    from_name:    process.env.EMAIL_FROM_NAME      ?? 'Bitmonie',
  },
  postmark: {
    server_token:   process.env.POSTMARK_SERVER_TOKEN  ?? '',
    from_address:   process.env.EMAIL_FROM_ADDRESS     ?? '',
    from_name:      process.env.EMAIL_FROM_NAME        ?? 'Bitmonie',
    message_stream: process.env.POSTMARK_MESSAGE_STREAM ?? 'outbound',
  },
}));
