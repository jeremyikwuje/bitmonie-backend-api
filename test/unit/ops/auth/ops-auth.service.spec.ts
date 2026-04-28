// Mock ESM-only / native dependencies before any imports load them
jest.mock('argon2', () => ({
  hash: jest.fn().mockResolvedValue('$argon2id$mock'),
  verify: jest.fn().mockResolvedValue(false),
}));
jest.mock('otplib', () => ({
  generateSecret: jest.fn().mockReturnValue('BASE32OPSSECRET'),
  verify: jest.fn().mockResolvedValue({ valid: true, delta: 0 }),
  generateURI: jest.fn().mockReturnValue('otpauth://totp/Bitmonie%20Ops:ops%40example.com?secret=BASE32OPSSECRET&issuer=Bitmonie%20Ops'),
}));
jest.mock('qrcode', () => ({
  toDataURL: jest.fn().mockResolvedValue('data:image/png;base64,MOCK'),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { mock, MockProxy } from 'jest-mock-extended';
import { OpsAuthService } from '@/modules/ops/auth/ops-auth.service';
import { OpsSessionService } from '@/modules/ops/auth/ops-session.service';
import { CryptoService } from '@/common/crypto/crypto.service';
import { REDIS_CLIENT } from '@/database/redis.module';
import { PrismaService } from '@/database/prisma.service';

function make_prisma() {
  return {
    opsUser: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
}

type MockRedis = {
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
};

function make_ops_user(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ops-uuid',
    email: 'ops@example.com',
    password_hash: 'hashed',
    totp_secret: 'enc-secret',
    totp_enabled: true,
    full_name: 'Ops Person',
    is_active: true,
    last_login_at: null as Date | null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('OpsAuthService', () => {
  let service: OpsAuthService;
  let prisma: ReturnType<typeof make_prisma>;
  let ops_session_service: MockProxy<OpsSessionService>;
  let crypto_service: MockProxy<CryptoService>;
  let redis: MockRedis;

  beforeEach(async () => {
    prisma = make_prisma();
    ops_session_service = mock<OpsSessionService>();
    crypto_service = mock<CryptoService>();
    redis = {
      get: jest.fn(),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpsAuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: OpsSessionService, useValue: ops_session_service },
        { provide: CryptoService, useValue: crypto_service },
        { provide: REDIS_CLIENT, useValue: redis },
      ],
    }).compile();

    service = module.get(OpsAuthService);
  });

  // ── login ───────────────────────────────────────────────────────────────────

  describe('login', () => {
    it('throws OPS_INVALID_CREDENTIALS for unknown email', async () => {
      prisma.opsUser.findUnique.mockResolvedValue(null);

      await expect(service.login({ email: 'nope@example.com', password: 'p' }))
        .rejects.toMatchObject({ code: 'OPS_INVALID_CREDENTIALS' });
    });

    it('throws OPS_INVALID_CREDENTIALS on bad password (no user-enumeration)', async () => {
      const argon2 = await import('argon2');
      (argon2.verify as jest.Mock).mockResolvedValue(false);
      prisma.opsUser.findUnique.mockResolvedValue(make_ops_user());

      await expect(service.login({ email: 'ops@example.com', password: 'wrong' }))
        .rejects.toMatchObject({ code: 'OPS_INVALID_CREDENTIALS' });
    });

    it('throws OPS_USER_DISABLED when ops_user.is_active=false', async () => {
      const argon2 = await import('argon2');
      (argon2.verify as jest.Mock).mockResolvedValue(true);
      prisma.opsUser.findUnique.mockResolvedValue(make_ops_user({ is_active: false }));

      await expect(service.login({ email: 'ops@example.com', password: 'right' }))
        .rejects.toMatchObject({ code: 'OPS_USER_DISABLED' });
    });

    it('throws OPS_2FA_ENROLMENT_REQUIRED with enrolment_token when totp_enabled=false', async () => {
      const argon2 = await import('argon2');
      (argon2.verify as jest.Mock).mockResolvedValue(true);
      prisma.opsUser.findUnique.mockResolvedValue(make_ops_user({ totp_enabled: false, totp_secret: null }));

      await expect(service.login({ email: 'ops@example.com', password: 'right' }))
        .rejects.toMatchObject({ code: 'OPS_2FA_ENROLMENT_REQUIRED' });

      expect(redis.set).toHaveBeenCalledWith(
        expect.stringMatching(/^ops_auth:enrolment:[0-9a-f]+$/),
        'ops-uuid',
        'EX',
        900,
      );
    });

    it('throws OPS_2FA_REQUIRED with challenge_id on valid creds + totp_enabled', async () => {
      const argon2 = await import('argon2');
      (argon2.verify as jest.Mock).mockResolvedValue(true);
      prisma.opsUser.findUnique.mockResolvedValue(make_ops_user());

      await expect(service.login({ email: 'ops@example.com', password: 'right' }))
        .rejects.toMatchObject({ code: 'OPS_2FA_REQUIRED' });

      // No session issued at this step
      expect(ops_session_service.create).not.toHaveBeenCalled();
      expect(redis.set).toHaveBeenCalledWith(
        expect.stringMatching(/^ops_auth:challenge:[0-9a-f]+$/),
        'ops-uuid',
        'EX',
        300,
      );
    });
  });

  // ── verifyTwoFactor ─────────────────────────────────────────────────────────

  describe('verifyTwoFactor', () => {
    it('throws OPS_2FA_INVALID when challenge_id missing from Redis', async () => {
      redis.get.mockResolvedValue(null);

      await expect(service.verifyTwoFactor({ challenge_id: 'stale', totp_code: '123456' }))
        .rejects.toMatchObject({ code: 'OPS_2FA_INVALID' });
    });

    it('throws OPS_2FA_INVALID when TOTP code wrong', async () => {
      const otplib = await import('otplib');
      (otplib.verify as jest.Mock).mockResolvedValue({ valid: false });
      redis.get.mockResolvedValue('ops-uuid');
      prisma.opsUser.findUnique.mockResolvedValue(make_ops_user());
      crypto_service.decrypt.mockReturnValue('plain-secret');

      await expect(service.verifyTwoFactor({ challenge_id: 'c', totp_code: 'bad' }))
        .rejects.toMatchObject({ code: 'OPS_2FA_INVALID' });
    });

    it('throws OPS_USER_DISABLED if user disabled between login and verify', async () => {
      const otplib = await import('otplib');
      (otplib.verify as jest.Mock).mockResolvedValue({ valid: true });
      redis.get.mockResolvedValue('ops-uuid');
      prisma.opsUser.findUnique.mockResolvedValue(make_ops_user({ is_active: false }));

      await expect(service.verifyTwoFactor({ challenge_id: 'c', totp_code: '111111' }))
        .rejects.toMatchObject({ code: 'OPS_USER_DISABLED' });
    });

    it('issues session, burns challenge, updates last_login_at on valid TOTP', async () => {
      const otplib = await import('otplib');
      (otplib.verify as jest.Mock).mockResolvedValue({ valid: true });
      redis.get.mockResolvedValue('ops-uuid');
      prisma.opsUser.findUnique.mockResolvedValue(make_ops_user());
      crypto_service.decrypt.mockReturnValue('plain-secret');
      ops_session_service.create.mockResolvedValue('ops-session-token');

      const result = await service.verifyTwoFactor({
        challenge_id: 'c',
        totp_code: '111111',
        ip_address: '1.2.3.4',
        user_agent: 'curl/8',
      });

      expect(result).toEqual({ token: 'ops-session-token' });
      expect(redis.del).toHaveBeenCalledWith('ops_auth:challenge:c');
      expect(ops_session_service.create).toHaveBeenCalledWith({
        ops_user_id: 'ops-uuid',
        ip_address: '1.2.3.4',
        user_agent: 'curl/8',
      });
      expect(prisma.opsUser.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ops-uuid' },
          data: expect.objectContaining({ last_login_at: expect.any(Date) }),
        }),
      );
    });
  });

  // ── startEnrolment ──────────────────────────────────────────────────────────

  describe('startEnrolment', () => {
    it('throws OPS_2FA_INVALID when enrolment_token expired', async () => {
      redis.get.mockResolvedValue(null);

      await expect(service.startEnrolment({ enrolment_token: 'stale' }))
        .rejects.toMatchObject({ code: 'OPS_2FA_INVALID' });
    });

    it('persists encrypted secret and returns plaintext + QR', async () => {
      redis.get.mockResolvedValue('ops-uuid');
      prisma.opsUser.findUnique.mockResolvedValue(make_ops_user({ totp_enabled: false, totp_secret: null }));
      crypto_service.encrypt.mockReturnValue('enc-fresh');

      const result = await service.startEnrolment({ enrolment_token: 'tok' });

      expect(result.secret).toBe('BASE32OPSSECRET');
      expect(result.qr_code_uri).toContain('data:image/png;base64,');
      expect(prisma.opsUser.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ops-uuid' },
          data: expect.objectContaining({
            totp_secret: 'enc-fresh',
            totp_enabled: false,
          }),
        }),
      );
    });
  });

  // ── confirmEnrolment ────────────────────────────────────────────────────────

  describe('confirmEnrolment', () => {
    it('throws OPS_2FA_INVALID when no secret was provisioned', async () => {
      redis.get.mockResolvedValue('ops-uuid');
      prisma.opsUser.findUnique.mockResolvedValue(make_ops_user({ totp_enabled: false, totp_secret: null }));

      await expect(service.confirmEnrolment({ enrolment_token: 't', totp_code: '111111' }))
        .rejects.toMatchObject({ code: 'OPS_2FA_INVALID' });
    });

    it('throws OPS_2FA_INVALID when TOTP code wrong', async () => {
      const otplib = await import('otplib');
      (otplib.verify as jest.Mock).mockResolvedValue({ valid: false });
      redis.get.mockResolvedValue('ops-uuid');
      prisma.opsUser.findUnique.mockResolvedValue(make_ops_user({ totp_enabled: false, totp_secret: 'enc' }));
      crypto_service.decrypt.mockReturnValue('plain');

      await expect(service.confirmEnrolment({ enrolment_token: 't', totp_code: 'bad' }))
        .rejects.toMatchObject({ code: 'OPS_2FA_INVALID' });
    });

    it('flips totp_enabled, burns enrolment_token, issues session on success', async () => {
      const otplib = await import('otplib');
      (otplib.verify as jest.Mock).mockResolvedValue({ valid: true });
      redis.get.mockResolvedValue('ops-uuid');
      prisma.opsUser.findUnique.mockResolvedValue(make_ops_user({ totp_enabled: false, totp_secret: 'enc' }));
      crypto_service.decrypt.mockReturnValue('plain');
      ops_session_service.create.mockResolvedValue('first-session-token');

      const result = await service.confirmEnrolment({
        enrolment_token: 't',
        totp_code: '111111',
      });

      expect(result).toEqual({ token: 'first-session-token' });
      expect(redis.del).toHaveBeenCalledWith('ops_auth:enrolment:t');
      expect(prisma.opsUser.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ops-uuid' },
          data: expect.objectContaining({ totp_enabled: true }),
        }),
      );
      expect(ops_session_service.create).toHaveBeenCalled();
    });
  });

  // ── logout ──────────────────────────────────────────────────────────────────

  describe('logout', () => {
    it('hashes the bare token and asks the session service to destroy it', async () => {
      const { createHash } = await import('crypto');
      const expected_hash = createHash('sha256').update('raw-token').digest('hex');

      await service.logout('raw-token');

      expect(ops_session_service.destroy).toHaveBeenCalledWith(expected_hash);
    });
  });
});
