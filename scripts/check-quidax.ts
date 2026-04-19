/**
 * Quick smoke test for the price feed provider.
 * Run: npx ts-node -r tsconfig-paths/register scripts/check-quidax.ts
 */
import 'dotenv/config';
import Decimal from 'decimal.js';
import { QuidaxProvider } from '@/providers/quidax/quidax.provider';

// Mirror of MARKUP from src/common/constants/index.ts
const MARKUP = new Decimal('0.005');

const api_key = process.env.QUIDAX_API_KEY ?? '';
const base_url = process.env.QUIDAX_BASE_URL ?? 'https://app.quidax.io/api/v1';

if (!api_key) {
  console.error('❌  QUIDAX_API_KEY is not set in .env');
  process.exit(1);
}

console.log(`Calling ${base_url}/markets/tickers/ …\n`);

const provider = new QuidaxProvider({ api_key, base_url });

provider
  .fetchRates()
  .then((rates) => {
    console.log(`✅  Got ${rates.length} rate(s)  (markup: ${MARKUP.mul(100).toFixed(2)}%):\n`);
    console.log(
      '  pair        origin_buy         origin_sell        stored_buy         stored_sell',
    );
    for (const r of rates) {
      const stored_buy  = r.rate_buy.mul(new Decimal(1).plus(MARKUP));
      const stored_sell = r.rate_sell.mul(new Decimal(1).minus(MARKUP));
      console.log(
        `  ${r.pair.padEnd(10)}` +
        `  ${r.rate_buy.toFixed(6).padStart(16)}` +
        `  ${r.rate_sell.toFixed(6).padStart(16)}` +
        `  ${stored_buy.toFixed(6).padStart(16)}` +
        `  ${stored_sell.toFixed(6).padStart(16)}`,
      );
    }
  })
  .catch((err: unknown) => {
    console.error('❌  fetchRates() failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
