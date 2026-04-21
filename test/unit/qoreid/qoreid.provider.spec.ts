import { QoreidProvider } from '@/providers/qoreid/qoreid.provider';
import type { QoreidConfig } from '@/config/providers.config';

const CONFIG: QoreidConfig = {
  client_id: 'test_client',
  client_secret: 'test_secret',
  base_url: 'https://api.qoreid.com',
};

const TOKEN_RESPONSE = { accessToken: 'test_token', expiresIn: 3600 };

const BVN_PARAMS = {
  id_number: '12345678901',
  first_name: 'Ada',
  last_name: 'Obi',
  date_of_birth: '01-01-1990',
};

function mock_responses(...bodies: unknown[]) {
  let call_index = 0;
  global.fetch = jest.fn().mockImplementation(() => {
    const body = bodies[call_index] ?? bodies[bodies.length - 1];
    call_index++;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body), text: () => Promise.resolve('') });
  });
}

function mock_fail(status = 401) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    text: () => Promise.resolve('Unauthorized'),
  });
}

afterEach(() => jest.resetAllMocks());

// ── verifyBvn ─────────────────────────────────────────────────────────────────

describe('QoreidProvider.verifyBvn', () => {
  const BVN_RESPONSE = {
    bvn: {
      bvn: '12345678901',
      firstname: 'Ada',
      lastname: 'Obi',
      middlename: 'Grace',
      birthdate: '01-01-1990',
      gender: 'Female',
    },
    insight: [],
  };

  it('returns legal_name assembled from firstname middlename lastname', async () => {
    mock_responses(TOKEN_RESPONSE, BVN_RESPONSE);
    const provider = new QoreidProvider(CONFIG);
    const result = await provider.verifyBvn(BVN_PARAMS);

    expect(result.legal_name).toBe('Ada Grace Obi');
    expect(result.provider_reference).toBe('12345678901');
    expect(result.date_of_birth).toBe('01-01-1990');
  });

  it('omits missing name parts from legal_name', async () => {
    mock_responses(TOKEN_RESPONSE, {
      bvn: { bvn: '12345678901', firstname: 'Ada', lastname: 'Obi' },
      insight: [],
    });
    const provider = new QoreidProvider(CONFIG);
    const result = await provider.verifyBvn(BVN_PARAMS);
    expect(result.legal_name).toBe('Ada Obi');
  });

  it('sends Bearer token on the verify request', async () => {
    mock_responses(TOKEN_RESPONSE, BVN_RESPONSE);
    const provider = new QoreidProvider(CONFIG);
    await provider.verifyBvn(BVN_PARAMS);

    const verify_call = (global.fetch as jest.Mock).mock.calls[1];
    expect((verify_call[1].headers as Record<string, string>)['Authorization']).toBe(
      'Bearer test_token',
    );
  });

  it('throws when auth call fails', async () => {
    mock_fail(401);
    await expect(new QoreidProvider(CONFIG).verifyBvn(BVN_PARAMS)).rejects.toThrow('401');
  });

  it('throws when verify call returns non-ok', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(TOKEN_RESPONSE), text: () => Promise.resolve('') })
      .mockResolvedValueOnce({ ok: false, status: 400, text: () => Promise.resolve('Bad request') });

    await expect(new QoreidProvider(CONFIG).verifyBvn(BVN_PARAMS)).rejects.toThrow('400');
  });
});

// ── token caching ─────────────────────────────────────────────────────────────

describe('QoreidProvider token caching', () => {
  const BVN_RESPONSE = {
    bvn: { bvn: '12345678901', firstname: 'Ada', lastname: 'Obi' },
    insight: [],
  };

  it('reuses a valid token and only calls /token once for two requests', async () => {
    // token call + 2 verify calls
    mock_responses(TOKEN_RESPONSE, BVN_RESPONSE, BVN_RESPONSE);
    const provider = new QoreidProvider(CONFIG);

    await provider.verifyBvn(BVN_PARAMS);
    await provider.verifyBvn(BVN_PARAMS);

    const token_calls = (global.fetch as jest.Mock).mock.calls.filter((c: unknown[]) =>
      (c[0] as string).endsWith('/token'),
    );
    expect(token_calls).toHaveLength(1);
  });
});

// ── verifyNin ─────────────────────────────────────────────────────────────────

describe('QoreidProvider.verifyNin', () => {
  it('returns legal_name and provider_reference', async () => {
    mock_responses(TOKEN_RESPONSE, {
      nin: '98765432100',
      firstname: 'Emeka',
      lastname: 'Nwosu',
      birthdate: '15-06-1985',
      insight: [],
    });
    const provider = new QoreidProvider(CONFIG);
    const result = await provider.verifyNin({ ...BVN_PARAMS, id_number: '98765432100' });

    expect(result.legal_name).toBe('Emeka Nwosu');
    expect(result.provider_reference).toBe('98765432100');
    expect(result.date_of_birth).toBe('15-06-1985');
  });
});

// ── verifyPassport ────────────────────────────────────────────────────────────

describe('QoreidProvider.verifyPassport', () => {
  it('returns legal_name and provider_reference', async () => {
    mock_responses(TOKEN_RESPONSE, {
      passport: {
        passport_number: 'A12345678',
        firstname: 'Funke',
        lastname: 'Adeyemi',
        birthdate: '20-03-1980',
      },
      insight: [],
    });
    const provider = new QoreidProvider(CONFIG);
    const result = await provider.verifyPassport({ ...BVN_PARAMS, id_number: 'A12345678' });

    expect(result.legal_name).toBe('Funke Adeyemi');
    expect(result.provider_reference).toBe('A12345678');
  });
});
