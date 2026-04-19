/**
 * Quick smoke test for the price feed provider.
 * Run: npx ts-node -r tsconfig-paths/register scripts/check-quidax.ts
 */
import 'dotenv/config';
import { QuidaxProvider } from '@/providers/quidax/quidax.provider';

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
    console.log(`✅  Got ${rates.length} rate(s):\n`);
    for (const r of rates) {
      console.log(`  ${r.pair.padEnd(10)}  buy=${r.rate_buy.toFixed(6)}  sell=${r.rate_sell.toFixed(6)}`);
    }
  })
  .catch((err: unknown) => {
    console.error('❌  fetchRates() failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
