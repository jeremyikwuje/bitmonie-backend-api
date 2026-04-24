import * as crypto from 'crypto';
import { BlinkProvider } from '@/providers/blink/blink.provider';
import type { BlinkConfig } from '@/config/providers.config';

// ── Helpers ───────────────────────────────────────────────────────────────────

const SECRET_RAW = 'test_webhook_secret_32bytes_here';
const SECRET_B64 = Buffer.from(SECRET_RAW).toString('base64');
const WEBHOOK_SECRET = `whsec_${SECRET_B64}`;

const WALLET_ID = 'wallet-uuid-btc';

function make_config(overrides: Partial<BlinkConfig> = {}): BlinkConfig {
  return {
    api_key:        'test_api_key',
    base_url:       'https://api.blink.sv',
    wallet_btc_id:  WALLET_ID,
    wallet_usd_id:  'wallet-uuid-usd',
    account_id:     'account-uuid-001',
    webhook_secret: WEBHOOK_SECRET,
    ...overrides,
  };
}

function make_provider(overrides?: Partial<BlinkConfig>): BlinkProvider {
  return new BlinkProvider(make_config(overrides));
}

function make_svix_signature(
  raw_body: string,
  msg_id = 'msg_test123',
  timestamp_override?: number,
): { headers: Record<string, string>; json: string } {
  const ts = timestamp_override ?? Math.floor(Date.now() / 1000);
  const signed_content = `${msg_id}.${ts}.${raw_body}`;
  const secret_bytes = Buffer.from(SECRET_B64, 'base64');
  const sig = crypto
    .createHmac('sha256', secret_bytes)
    .update(signed_content)
    .digest('base64');

  const headers = {
    'svix-id': msg_id,
    'svix-timestamp': String(ts),
    'svix-signature': `v1,${sig}`,
  };
  return { headers, json: JSON.stringify(headers) };
}

// ── createPaymentRequest ──────────────────────────────────────────────────────

describe('BlinkProvider.createPaymentRequest', () => {
  const MOCK_INVOICE_RESPONSE = {
    data: {
      lnInvoiceCreate: {
        invoice: {
          paymentRequest: 'lnbc1000n1ptest_bolt11',
          paymentHash: 'abc123paymenthash',
          satoshis: 1000,
        },
        errors: [],
      },
    },
  };

  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      json: () => Promise.resolve(MOCK_INVOICE_RESPONSE),
    });
  });

  afterEach(() => jest.resetAllMocks());

  it('calls lnInvoiceCreate with correct walletId and amount', async () => {
    const provider = make_provider();
    await provider.createPaymentRequest({
      amount_sat: 1000n,
      memo: 'Loan #123 collateral',
      expiry_seconds: 1800,
    });

    const call = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(call[1].body as string) as { variables: { input: Record<string, unknown> } };
    expect(body.variables.input.walletId).toBe(WALLET_ID);
    expect(body.variables.input.amount).toBe(1000);
    expect(body.variables.input.memo).toBe('Loan #123 collateral');
    expect(body.variables.input.expiresIn).toBe(30); // ceil(1800/60)
  });

  it('returns provider_reference equal to paymentHash', async () => {
    const provider = make_provider();
    const result = await provider.createPaymentRequest({
      amount_sat: 1000n,
      memo: 'test',
      expiry_seconds: 1800,
    });

    expect(result.provider_reference).toBe('abc123paymenthash');
    expect(result.receiving_address).toBe('abc123paymenthash');
  });

  it('returns the BOLT11 invoice as payment_request', async () => {
    const provider = make_provider();
    const result = await provider.createPaymentRequest({
      amount_sat: 1000n,
      memo: 'test',
      expiry_seconds: 1800,
    });

    expect(result.payment_request).toBe('lnbc1000n1ptest_bolt11');
  });

  it('sets expires_at to now + expiry_seconds', async () => {
    const provider = make_provider();
    const before = Date.now();
    const result = await provider.createPaymentRequest({
      amount_sat: 1000n,
      memo: 'test',
      expiry_seconds: 1800,
    });
    const after = Date.now();

    const diff_ms = result.expires_at.getTime() - before;
    expect(diff_ms).toBeGreaterThanOrEqual(1800 * 1000);
    expect(result.expires_at.getTime()).toBeLessThanOrEqual(after + 1800 * 1000 + 100);
  });

  it('rounds up fractional minutes for expiresIn', async () => {
    const provider = make_provider();
    await provider.createPaymentRequest({
      amount_sat: 500n,
      memo: 'test',
      expiry_seconds: 1801, // 30.016... minutes → should send 31
    });

    const call = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(call[1].body as string) as { variables: { input: { expiresIn: number } } };
    expect(body.variables.input.expiresIn).toBe(31);
  });

  it('throws CollateralInvoiceFailedException when API returns errors', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      json: () =>
        Promise.resolve({
          data: {
            lnInvoiceCreate: {
              invoice: null,
              errors: [{ message: 'Wallet not found' }],
            },
          },
        }),
    });

    const provider = make_provider();
    await expect(
      provider.createPaymentRequest({ amount_sat: 1000n, memo: 'test', expiry_seconds: 1800 }),
    ).rejects.toMatchObject({ code: 'COLLATERAL_INVOICE_FAILED' });
  });

  it('throws CollateralInvoiceFailedException when invoice is null with no errors', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      json: () =>
        Promise.resolve({
          data: { lnInvoiceCreate: { invoice: null, errors: [] } },
        }),
    });

    const provider = make_provider();
    await expect(
      provider.createPaymentRequest({ amount_sat: 1000n, memo: 'test', expiry_seconds: 1800 }),
    ).rejects.toMatchObject({ code: 'COLLATERAL_INVOICE_FAILED' });
  });

  it('sends X-API-KEY header', async () => {
    const provider = make_provider({ api_key: 'my_secret_key' });
    await provider.createPaymentRequest({ amount_sat: 1000n, memo: 'test', expiry_seconds: 1800 });

    const call = (global.fetch as jest.Mock).mock.calls[0];
    expect((call[1].headers as Record<string, string>)['X-API-KEY']).toBe('my_secret_key');
  });
});

// ── createOnchainAddress ──────────────────────────────────────────────────────

describe('BlinkProvider.createOnchainAddress', () => {
  afterEach(() => jest.resetAllMocks());

  it('returns the BTC address string on success', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          data: {
            onChainAddressCreate: { address: 'bc1qtest123', errors: [] },
          },
        }),
    });

    const provider = make_provider();
    const address = await provider.createOnchainAddress();
    expect(address).toBe('bc1qtest123');
  });

  it('calls onChainAddressCreate with correct walletId', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          data: {
            onChainAddressCreate: { address: 'bc1qtest123', errors: [] },
          },
        }),
    });

    const provider = make_provider();
    await provider.createOnchainAddress();

    const call = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(call[1].body as string) as { variables: { input: Record<string, unknown> } };
    expect(body.variables.input.walletId).toBe(WALLET_ID);
  });

  it('throws when API returns errors', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          data: {
            onChainAddressCreate: { address: null, errors: [{ message: 'Wallet not found' }] },
          },
        }),
    });

    const provider = make_provider();
    await expect(provider.createOnchainAddress()).rejects.toThrow('Wallet not found');
  });

  it('throws when address is null with no errors', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          data: { onChainAddressCreate: { address: null, errors: [] } },
        }),
    });

    const provider = make_provider();
    await expect(provider.createOnchainAddress()).rejects.toThrow('onChainAddressCreate failed');
  });
});

// ── sendToLightningAddress ────────────────────────────────────────────────────

describe('BlinkProvider.sendToLightningAddress', () => {
  afterEach(() => jest.resetAllMocks());

  it('returns a reference string on SUCCESS', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          data: {
            lnAddressPaymentSend: { status: 'SUCCESS', errors: [] },
          },
        }),
    });

    const provider = make_provider();
    const ref = await provider.sendToLightningAddress({
      address: 'user@blink.sv',
      amount_sat: 50000n,
      memo: 'collateral release',
    });

    expect(typeof ref).toBe('string');
    expect(ref).toContain('user@blink.sv');
    expect(ref).toContain('50000');
  });

  it('calls lnAddressPaymentSend with correct walletId, address and amount', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          data: {
            lnAddressPaymentSend: { status: 'SUCCESS', errors: [] },
          },
        }),
    });

    const provider = make_provider();
    await provider.sendToLightningAddress({
      address: 'alice@blink.sv',
      amount_sat: 75000n,
      memo: 'surplus',
    });

    const call = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(call[1].body as string) as { variables: { input: Record<string, unknown> } };
    expect(body.variables.input.walletId).toBe(WALLET_ID);
    expect(body.variables.input.lnAddress).toBe('alice@blink.sv');
    expect(body.variables.input.amount).toBe(75000);
  });

  it('throws when status is FAILURE', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          data: {
            lnAddressPaymentSend: {
              status: 'FAILURE',
              errors: [{ message: 'Insufficient balance', code: 'INSUFFICIENT_BALANCE' }],
            },
          },
        }),
    });

    const provider = make_provider();
    await expect(
      provider.sendToLightningAddress({ address: 'user@blink.sv', amount_sat: 1n, memo: 'test' }),
    ).rejects.toThrow('Insufficient balance');
  });

  it('throws when errors array is non-empty even if status is not FAILURE', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          data: {
            lnAddressPaymentSend: {
              status: 'PENDING',
              errors: [{ message: 'Route not found' }],
            },
          },
        }),
    });

    const provider = make_provider();
    await expect(
      provider.sendToLightningAddress({ address: 'user@blink.sv', amount_sat: 1n, memo: 'test' }),
    ).rejects.toThrow('Route not found');
  });
});

// ── sendToOnchainAddress ──────────────────────────────────────────────────────
describe('BlinkProvider.sendToOnchainAddress', () => {
  afterEach(() => jest.resetAllMocks());

  it('returns a reference string on SUCCESS', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          data: {
            onChainPaymentSend: { status: 'SUCCESS', errors: [] },
          },
        }),
    });

    const provider = make_provider();
    const ref = await provider.sendToOnchainAddress({
      address: 'bc1qrecipient',
      amount_sat: 100000n,
    });

    expect(typeof ref).toBe('string');
    expect(ref).toContain('bc1qrecipient');
    expect(ref).toContain('100000');
  });

  it('calls onChainPaymentSend with correct walletId, address and amount', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          data: {
            onChainPaymentSend: { status: 'SUCCESS', errors: [] },
          },
        }),
    });

    const provider = make_provider();
    await provider.sendToOnchainAddress({ address: 'bc1qrecipient', amount_sat: 200000n });

    const call = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(call[1].body as string) as { variables: { input: Record<string, unknown> } };
    expect(body.variables.input.walletId).toBe(WALLET_ID);
    expect(body.variables.input.address).toBe('bc1qrecipient');
    expect(body.variables.input.amount).toBe(200000);
  });

  it('throws when status is FAILURE', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          data: {
            onChainPaymentSend: {
              status: 'FAILURE',
              errors: [{ message: 'Dust limit exceeded' }],
            },
          },
        }),
    });

    const provider = make_provider();
    await expect(
      provider.sendToOnchainAddress({ address: 'bc1qrecipient', amount_sat: 1n }),
    ).rejects.toThrow('Dust limit exceeded');
  });

  it('throws when errors array is non-empty', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          data: {
            onChainPaymentSend: {
              status: 'PENDING',
              errors: [{ message: 'Fee estimation failed' }],
            },
          },
        }),
    });

    const provider = make_provider();
    await expect(
      provider.sendToOnchainAddress({ address: 'bc1qrecipient', amount_sat: 50000n }),
    ).rejects.toThrow('Fee estimation failed');
  });
});

// ── verifyWebhookSignature ────────────────────────────────────────────────────

describe('BlinkProvider.verifyWebhookSignature', () => {
  const RAW_BODY = '{"id":"evt_1","type":"receive.lightning","data":{"paymentHash":"abc123"}}';

  it('returns true for a valid Svix signature', () => {
    const provider = make_provider();
    const { json } = make_svix_signature(RAW_BODY);
    expect(provider.verifyWebhookSignature(RAW_BODY, json)).toBe(true);
  });

  it('returns false when signature is tampered', () => {
    const provider = make_provider();
    const headers = {
      'svix-id': 'msg_test123',
      'svix-timestamp': String(Math.floor(Date.now() / 1000)),
      'svix-signature': 'v1,invalidsignaturevalue==',
    };
    expect(provider.verifyWebhookSignature(RAW_BODY, JSON.stringify(headers))).toBe(false);
  });

  it('returns false when raw body is different from what was signed', () => {
    const provider = make_provider();
    const { json } = make_svix_signature(RAW_BODY);
    expect(provider.verifyWebhookSignature('{"tampered":true}', json)).toBe(false);
  });

  it('returns false with wrong webhook_secret', () => {
    const provider = make_provider({
      webhook_secret: `whsec_${Buffer.from('wrong_secret').toString('base64')}`,
    });
    const { json } = make_svix_signature(RAW_BODY);
    expect(provider.verifyWebhookSignature(RAW_BODY, json)).toBe(false);
  });

  it('returns false when timestamp is older than 5 minutes', () => {
    const provider = make_provider();
    const stale_ts = Math.floor(Date.now() / 1000) - 301;
    const { json } = make_svix_signature(RAW_BODY, 'msg_test123', stale_ts);
    expect(provider.verifyWebhookSignature(RAW_BODY, json)).toBe(false);
  });

  it('returns false when svix-id is missing', () => {
    const provider = make_provider();
    const headers = {
      'svix-timestamp': String(Math.floor(Date.now() / 1000)),
      'svix-signature': 'v1,anything',
    };
    expect(provider.verifyWebhookSignature(RAW_BODY, JSON.stringify(headers))).toBe(false);
  });

  it('returns false when signature header is missing', () => {
    const provider = make_provider();
    const headers = {
      'svix-id': 'msg_test123',
      'svix-timestamp': String(Math.floor(Date.now() / 1000)),
    };
    expect(provider.verifyWebhookSignature(RAW_BODY, JSON.stringify(headers))).toBe(false);
  });

  it('returns false for malformed signature JSON', () => {
    const provider = make_provider();
    expect(provider.verifyWebhookSignature(RAW_BODY, 'not-json')).toBe(false);
  });

  it('accepts webhook_secret with or without whsec_ prefix', () => {
    // Without prefix — secret is treated as raw base64
    const raw_b64 = Buffer.from(SECRET_RAW).toString('base64');
    const provider_no_prefix = make_provider({ webhook_secret: raw_b64 });
    const { json } = make_svix_signature(RAW_BODY);
    // Should still verify (the replace(/^whsec_/, '') is a no-op on a plain base64 string)
    expect(provider_no_prefix.verifyWebhookSignature(RAW_BODY, json)).toBe(true);
  });

  it('accepts multiple space-delimited signatures (key rotation)', () => {
    const provider = make_provider();
    const { headers } = make_svix_signature(RAW_BODY);
    // Prepend a fake old signature — the real one is the second entry
    const multi_sig = `v1,oldfakesig== ${headers['svix-signature']}`;
    const sig_json = JSON.stringify({ ...headers, 'svix-signature': multi_sig });
    expect(provider.verifyWebhookSignature(RAW_BODY, sig_json)).toBe(true);
  });
});
