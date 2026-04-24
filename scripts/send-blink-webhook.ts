#!/usr/bin/env node
/**
 * Forges a signed Blink (Svix) webhook and POSTs it to the local API.
 *
 * Usage:
 *   node --env-file=.env -r ts-node/register scripts/send-blink-webhook.ts \
 *     --payment-hash <hash> --amount-sat <n> [--event-type receive.lightning]
 *
 * Defaults:
 *   --base-url      http://localhost:3000
 *   --event-type    receive.lightning
 *
 * Reads BLINK_WEBHOOK_SECRET, BLINK_ACCOUNT_ID, BLINK_WALLET_BTC_ID from env.
 */

import * as crypto from 'crypto';

interface Args {
  payment_hash: string;
  amount_sat: number;
  event_type: string;
  base_url: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const payment_hash = get('--payment-hash');
  const amount_sat_raw = get('--amount-sat');

  if (!payment_hash) { console.error('missing --payment-hash'); process.exit(1); }
  if (!amount_sat_raw) { console.error('missing --amount-sat'); process.exit(1); }

  return {
    payment_hash,
    amount_sat: parseInt(amount_sat_raw, 10),
    event_type: get('--event-type') ?? 'receive.lightning',
    base_url:   get('--base-url')   ?? 'http://localhost:3000',
  };
}

function signSvix(raw_body: string, secret_whsec: string): {
  'svix-id': string;
  'svix-timestamp': string;
  'svix-signature': string;
} {
  const msg_id = `msg_test_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const msg_ts = Math.floor(Date.now() / 1000).toString();
  const signed = `${msg_id}.${msg_ts}.${raw_body}`;

  const secret_b64 = secret_whsec.replace(/^whsec_/, '');
  const secret_bytes = Buffer.from(secret_b64, 'base64');
  const sig = crypto.createHmac('sha256', secret_bytes).update(signed).digest('base64');

  return {
    'svix-id':        msg_id,
    'svix-timestamp': msg_ts,
    'svix-signature': `v1,${sig}`,
  };
}

async function main(): Promise<void> {
  const args = parseArgs();

  const account_id = process.env.BLINK_ACCOUNT_ID;
  const wallet_btc = process.env.BLINK_WALLET_BTC_ID;
  const secret     = process.env.BLINK_WEBHOOK_SECRET;

  if (!account_id || !wallet_btc || !secret) {
    console.error('BLINK_ACCOUNT_ID, BLINK_WALLET_BTC_ID, BLINK_WEBHOOK_SECRET must be set');
    process.exit(1);
  }

  const payload = {
    accountId: account_id,
    eventType: args.event_type,
    walletId:  wallet_btc,
    transaction: {
      initiationVia: {
        type:        'Lightning',
        paymentHash: args.payment_hash,
      },
      status:             'SUCCESS',
      settlementAmount:   args.amount_sat,
      settlementCurrency: 'BTC',
      createdAt:          new Date().toISOString(),
    },
  };

  const raw_body = JSON.stringify(payload);
  const headers  = signSvix(raw_body, secret);

  const res = await fetch(`${args.base_url}/v1/webhooks/blink`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: raw_body,
  });

  console.log(`HTTP ${res.status}`);
  console.log(await res.text());
  process.exit(res.ok ? 0 : 1);
}

void main();
