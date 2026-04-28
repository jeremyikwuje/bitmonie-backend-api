import * as forge from 'node-forge';
import * as crypto from 'crypto';
import { PalmpayProvider } from '@/providers/palmpay/palmpay.provider';
import type { PalmpayConfig } from '@/config/providers.config';
import Decimal from 'decimal.js';

// ── RSA keypair generated once for all tests ─────────────────────────────────
// 1024-bit is sufficient for unit tests — we're verifying logic, not key strength.
// merchant_* = our own key (signs outbound requests + used for webhook verification tests)
let TEST_PUB_PEM:       string;
let TEST_PRIV_PEM:      string;
let TEST_PRIV_KEY:      forge.pki.rsa.PrivateKey;

beforeAll(() => {
  const keypair = forge.pki.rsa.generateKeyPair({ bits: 1024 });
  TEST_PUB_PEM  = forge.pki.publicKeyToPem(keypair.publicKey);
  TEST_PRIV_PEM = forge.pki.privateKeyToPem(keypair.privateKey);
  TEST_PRIV_KEY = keypair.privateKey;
});

function make_config(overrides: Partial<PalmpayConfig> = {}): PalmpayConfig {
  return {
    app_id: 'test_app_id',
    merchant_id: 'test_merchant',
    private_key: TEST_PRIV_PEM,
    public_key:  TEST_PUB_PEM,
    webhook_pub_key: TEST_PUB_PEM,
    base_url: 'https://open-gw-prod.palmpay-inc.com',
    notify_url: 'https://bitmonie.com/v1/webhooks/disbursement',
    webhook_ip_allowlist: [],
    ...overrides,
  };
}

function make_provider(overrides?: Partial<PalmpayConfig>) {
  return new PalmpayProvider(make_config(overrides));
}

function mock_ok(body: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  });
}

function mock_http_error(status: number, body: string) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    text: () => Promise.resolve(body),
    json: () => Promise.reject(new Error('not json')),
  });
}

function mock_non_json(body: string) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(body),
    json: () => Promise.reject(new Error('not json')),
  });
}

// Build a signed PalmPay-style webhook payload.
// PalmPay signs: MD5(sorted key=value params, excl. sign) using SHA1+RSA.
function build_signed_payload(params: Record<string, unknown>): Record<string, unknown> {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${String(params[k])}`)
    .join('&');
  const md5 = crypto.createHash('md5').update(sorted).digest('hex').toUpperCase();

  const md = forge.md.sha1.create();
  md.update(md5, 'utf8');
  const raw_sig = TEST_PRIV_KEY.sign(md);
  const sign = encodeURIComponent(forge.util.encode64(raw_sig));

  return { ...params, sign };
}

afterEach(() => jest.resetAllMocks());

// ── getBalance ────────────────────────────────────────────────────────────────

describe('PalmpayProvider.getBalance', () => {
  it('returns parsed balance fields', async () => {
    mock_ok({
      respCode: '00000000',
      respMsg: 'success',
      data: {
        availableBalance: 500000,
        frozenBalance: 10000,
        currentBalance: 510000,
        unSettleBalance: 5000,
      },
    });

    const result = await make_provider().getBalance();
    expect(result.available_ngn).toBe(500000);
    expect(result.frozen_ngn).toBe(10000);
    expect(result.current_ngn).toBe(510000);
    expect(result.unsettle_ngn).toBe(5000);
  });

  it('returns zeros when data is absent', async () => {
    mock_ok({ respCode: '00000000', respMsg: 'success' });
    const result = await make_provider().getBalance();
    expect(result.available_ngn).toBe(0);
  });
});

// ── lookupAccountName ─────────────────────────────────────────────────────────

describe('PalmpayProvider.lookupAccountName', () => {
  it('returns accountName on success', async () => {
    mock_ok({ respCode: '00000000', respMsg: 'success', data: { accountName: 'Ada Obi' } });

    const name = await make_provider().lookupAccountName({
      bank_code: '058',
      account_number: '0123456789',
    });
    expect(name).toBe('Ada Obi');
  });

  it('returns null when respCode is not success', async () => {
    mock_ok({ respCode: '99999999', respMsg: 'Account not found' });

    const name = await make_provider().lookupAccountName({
      bank_code: '058',
      account_number: '0000000000',
    });
    expect(name).toBeNull();
  });

  it('sends bankCode and bankAccNo in the request body', async () => {
    mock_ok({ respCode: '00000000', respMsg: 'success', data: { accountName: 'Test' } });

    await make_provider().lookupAccountName({ bank_code: '058', account_number: '0123456789' });

    const call = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(call[1].body as string) as Record<string, unknown>;
    expect(body.bankCode).toBe('058');
    expect(body.bankAccNo).toBe('0123456789');
  });
});

// ── initiateTransfer ──────────────────────────────────────────────────────────

describe('PalmpayProvider.initiateTransfer', () => {
  const TRANSFER_PARAMS = {
    amount: new Decimal('50000.00'),
    currency: 'NGN',
    provider_name: 'GTBank',
    provider_code: '058',
    account_unique: '0123456789',
    account_name: 'Ada Obi',
    reference: 'txn_ref_001',
    narration: 'Loan disbursement',
  };

  it('returns provider_txn_id and provider_response on success', async () => {
    mock_ok({
      respCode: '00000000',
      respMsg: 'success',
      data: { orderId: 'palmpay_internal_id', orderNo: 'txn_ref_001', orderStatus: 1 },
    });

    const result = await make_provider().initiateTransfer(TRANSFER_PARAMS);
    // PalmpayProvider maps data.orderNo (our reference echoed back) to provider_txn_id
    expect(result.provider_txn_id).toBe('txn_ref_001');
    expect(result.provider_response).toBeDefined();
  });

  it('throws when respCode indicates failure', async () => {
    mock_ok({ respCode: '40000001', respMsg: 'Insufficient funds' });

    await expect(make_provider().initiateTransfer(TRANSFER_PARAMS)).rejects.toThrow(
      'PalmPay payout failed',
    );
  });

  // Regression: PalmPay returns the literal `data: null` (not omitted) on
  // every error response. If the Zod schema rejects null, the real PalmPay
  // failure reason gets replaced with a Zod issue dump in the outflow row.
  it('throws the PalmPay failure reason (not a Zod error) when response is { respCode, respMsg, data: null }', async () => {
    mock_ok({ respCode: '40000099', respMsg: 'Account inactive', data: null });

    await expect(make_provider().initiateTransfer(TRANSFER_PARAMS)).rejects.toThrow(
      'PalmPay payout failed: 40000099 Account inactive',
    );
  });

  it('surfaces the HTTP status + body when PalmPay returns non-2xx', async () => {
    mock_http_error(503, '<html>Service Unavailable</html>');

    await expect(make_provider().initiateTransfer(TRANSFER_PARAMS)).rejects.toThrow(
      /HTTP 503/,
    );
  });

  it('surfaces a clear error when PalmPay returns non-JSON body', async () => {
    mock_non_json('upstream timeout');

    await expect(make_provider().initiateTransfer(TRANSFER_PARAMS)).rejects.toThrow(
      'returned non-JSON response',
    );
  });

  it('sends orderId, amount and payeeBankCode in body', async () => {
    mock_ok({
      respCode: '00000000',
      respMsg: 'success',
      data: { orderId: 'id', orderNo: 'ref' },
    });

    await make_provider().initiateTransfer(TRANSFER_PARAMS);

    const call = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(call[1].body as string) as Record<string, unknown>;
    expect(body.orderId).toBe('txn_ref_001');
    expect(body.amount).toBe(50000);
    expect(body.payeeBankCode).toBe('058');
  });
});

// ── getTransferStatus ─────────────────────────────────────────────────────────

describe('PalmpayProvider.getTransferStatus', () => {
  it('returns "successful" for orderStatus 2', async () => {
    mock_ok({ respCode: '00000000', respMsg: 'ok', data: { orderStatus: 2 } });
    const result = await make_provider().getTransferStatus('txn_ref_001');
    expect(result.status).toBe('successful');
  });

  it('returns "failed" for orderStatus 3', async () => {
    mock_ok({ respCode: '00000000', respMsg: 'ok', data: { orderStatus: 3, message: 'Declined' } });
    const result = await make_provider().getTransferStatus('txn_ref_001');
    expect(result.status).toBe('failed');
    expect(result.failure_reason).toBe('Declined');
  });

  it('returns "processing" for orderStatus 1', async () => {
    mock_ok({ respCode: '00000000', respMsg: 'ok', data: { orderStatus: 1 } });
    const result = await make_provider().getTransferStatus('txn_ref_001');
    expect(result.status).toBe('processing');
  });

  it('returns "processing" when orderStatus is absent', async () => {
    mock_ok({ respCode: '00000000', respMsg: 'ok', data: {} });
    const result = await make_provider().getTransferStatus('txn_ref_001');
    expect(result.status).toBe('processing');
  });
});

// ── verifyWebhookSignature ────────────────────────────────────────────────────

describe('PalmpayProvider.verifyWebhookSignature', () => {
  it('returns true for a validly signed payload', () => {
    const payload = build_signed_payload({
      orderId: 'txn_001',
      orderStatus: 2,
      amount: 50000,
      appId: 'test_app_id',
    });
    const raw_body = JSON.stringify(payload);
    expect(make_provider().verifyWebhookSignature(raw_body, '')).toBe(true);
  });

  it('returns true when sign field is missing (collection notifications have optional sign)', () => {
    const raw_body = JSON.stringify({ orderId: 'txn_001', orderStatus: 2 });
    expect(make_provider().verifyWebhookSignature(raw_body, '')).toBe(true);
  });

  it('returns false when payload is tampered after signing', () => {
    const payload = build_signed_payload({ orderId: 'txn_001', orderStatus: 2 }) as Record<string, unknown>;
    payload['orderStatus'] = 3; // tamper
    expect(make_provider().verifyWebhookSignature(JSON.stringify(payload), '')).toBe(false);
  });

  it('returns false for malformed JSON', () => {
    expect(make_provider().verifyWebhookSignature('not-json', '')).toBe(false);
  });

  it('returns false when verified with wrong public key', () => {
    const payload = build_signed_payload({ orderId: 'txn_001', orderStatus: 2 });
    const raw_body = JSON.stringify(payload);
    // Provider configured with a different public key
    const other_keypair = forge.pki.rsa.generateKeyPair({ bits: 1024 });
    const provider = make_provider({ webhook_pub_key: forge.pki.publicKeyToPem(other_keypair.publicKey) });
    expect(provider.verifyWebhookSignature(raw_body, '')).toBe(false);
  });
});
