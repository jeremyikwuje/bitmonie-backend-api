import { DojahProvider } from '@/providers/dojah/dojah.provider';
import type { DojahConfig } from '@/config/providers.config';

const CONFIG: DojahConfig = { app_id: 'test_app_id', api_key: 'test_api_key' };

const PARAMS = {
  id_number: '12345678901',
  first_name: 'Ada',
  last_name: 'Obi',
  date_of_birth: '01-01-1990',
};

function mock_ok(body: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(''),
  });
}

function mock_fail(status = 400) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    text: () => Promise.resolve('Bad request'),
  });
}

afterEach(() => jest.resetAllMocks());

// ── verifyBvn ─────────────────────────────────────────────────────────────────

describe('DojahProvider.verifyBvn', () => {
  it('returns legal_name from first_name + middle_name + last_name', async () => {
    mock_ok({
      entity: {
        bvn: '12345678901',
        first_name: 'Ada',
        middle_name: 'Grace',
        last_name: 'Obi',
        date_of_birth: '1990-01-01',
      },
    });
    const result = await new DojahProvider(CONFIG).verifyBvn(PARAMS);

    expect(result.legal_name).toBe('Ada Grace Obi');
    expect(result.provider_reference).toBe('12345678901');
    expect(result.date_of_birth).toBe('1990-01-01');
  });

  it('uses full_name when present instead of building from parts', async () => {
    mock_ok({
      entity: {
        bvn: '12345678901',
        full_name: 'Ada Grace Obi',
        first_name: 'Ada',
        last_name: 'Obi',
        date_of_birth: '1990-01-01',
      },
    });
    const result = await new DojahProvider(CONFIG).verifyBvn(PARAMS);
    expect(result.legal_name).toBe('Ada Grace Obi');
  });

  it('sends AppId and Authorization headers', async () => {
    mock_ok({ entity: { bvn: '12345678901', first_name: 'Ada', last_name: 'Obi' } });
    await new DojahProvider(CONFIG).verifyBvn(PARAMS);

    const call = (global.fetch as jest.Mock).mock.calls[0];
    const headers = call[1].headers as Record<string, string>;
    expect(headers['AppId']).toBe('test_app_id');
    expect(headers['Authorization']).toBe('test_api_key');
  });

  it('includes bvn number as query param in the URL', async () => {
    mock_ok({ entity: { bvn: '12345678901', first_name: 'Ada', last_name: 'Obi' } });
    await new DojahProvider(CONFIG).verifyBvn(PARAMS);

    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('bvn=12345678901');
  });

  it('throws on non-ok response', async () => {
    mock_fail(400);
    await expect(new DojahProvider(CONFIG).verifyBvn(PARAMS)).rejects.toThrow('400');
  });
});

// ── verifyNin ─────────────────────────────────────────────────────────────────

describe('DojahProvider.verifyNin', () => {
  it('returns legal_name and provider_reference', async () => {
    mock_ok({
      entity: {
        nin: '98765432100',
        first_name: 'Emeka',
        last_name: 'Nwosu',
        date_of_birth: '1985-06-15',
      },
    });
    const result = await new DojahProvider(CONFIG).verifyNin({ ...PARAMS, id_number: '98765432100' });

    expect(result.legal_name).toBe('Emeka Nwosu');
    expect(result.provider_reference).toBe('98765432100');
  });

  it('includes nin number as query param', async () => {
    mock_ok({ entity: { nin: '98765432100', first_name: 'Emeka', last_name: 'Nwosu' } });
    await new DojahProvider(CONFIG).verifyNin({ ...PARAMS, id_number: '98765432100' });

    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('nin=98765432100');
  });
});

// ── verifyPassport ────────────────────────────────────────────────────────────

describe('DojahProvider.verifyPassport', () => {
  it('returns legal_name and passport_number as provider_reference', async () => {
    mock_ok({
      entity: {
        passport_number: 'A12345678',
        first_name: 'Funke',
        last_name: 'Adeyemi',
        date_of_birth: '1980-03-20',
      },
    });
    const result = await new DojahProvider(CONFIG).verifyPassport({ ...PARAMS, id_number: 'A12345678' });

    expect(result.provider_reference).toBe('A12345678');
    expect(result.legal_name).toBe('Funke Adeyemi');
  });
});

// ── verifyDriversLicense ──────────────────────────────────────────────────────

describe('DojahProvider.verifyDriversLicense', () => {
  it('returns legal_name and license_number as provider_reference', async () => {
    mock_ok({
      entity: {
        license_number: 'Lagos-DL-123',
        first_name: 'Shola',
        last_name: 'Bello',
        date_of_birth: '1995-11-07',
      },
    });
    const result = await new DojahProvider(CONFIG).verifyDriversLicense({
      ...PARAMS,
      id_number: 'Lagos-DL-123',
    });

    expect(result.provider_reference).toBe('Lagos-DL-123');
    expect(result.legal_name).toBe('Shola Bello');
  });
});
