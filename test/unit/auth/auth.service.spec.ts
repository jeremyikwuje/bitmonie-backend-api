// Mock ESM-only / native dependencies before any imports load them
jest.mock('argon2', () => ({
  hash: jest.fn().mockResolvedValue('$argon2id$mock'),
  verify: jest.fn().mockResolvedValue(false),
}));
jest.mock('otplib', () => ({
  generateSecret: jest.fn().mockReturnValue('BASE32TESTSECRET'),
  generate: jest.fn().mockResolvedValue('000000'),
  verify: jest.fn().mockResolvedValue({ valid: true, delta: 0 }),
  generateURI: jest.fn().mockReturnValue('otpauth://totp/Bitmonie:test%40example.com?secret=BASE32TESTSECRET&issuer=Bitmonie'),
}));
jest.mock('qrcode', () => ({
  toDataURL: jest.fn().mockResolvedValue('data:image/png;base64,MOCK'),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { mock, MockProxy } from 'jest-mock-extended';
import { createHash } from 'crypto';
import { AuthService } from '@/modules/auth/auth.service';
import { SessionService } from '@/modules/auth/session.service';
import { EMAIL_PROVIDER } from '@/modules/auth/email.provider.interface';
import { CryptoService } from '@/common/crypto/crypto.service';
import { REDIS_CLIENT } from '@/database/redis.module';
import { PrismaService } from '@/database/prisma.service';

function make_prisma() {
  return {
    user: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };
}

type MockRedis = {
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
  incr: jest.Mock;
  expire: jest.Mock;
};

function make_user(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-uuid',
    email: 'test@example.com',
    email_verified: true,
    totp_enabled: false,
    totp_secret: null as string | null,
    transaction_pin_hash:            null as string | null,
    transaction_pin_set_at:          null as Date | null,
    transaction_pin_failed_attempts: 0,
    transaction_pin_locked_until:    null as Date | null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('AuthService', () => {
  let service: AuthService;
  let prisma: ReturnType<typeof make_prisma>;
  let session_service: MockProxy<SessionService>;
  let crypto_service: MockProxy<CryptoService>;
  let redis: MockRedis;

  beforeEach(async () => {
    prisma = make_prisma();
    session_service = mock<SessionService>();
    crypto_service = mock<CryptoService>();
    redis = {
      get: jest.fn(),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: SessionService, useValue: session_service },
        { provide: CryptoService, useValue: crypto_service },
        { provide: REDIS_CLIENT, useValue: redis },
        { provide: EMAIL_PROVIDER, useValue: { sendOtp: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  // ── signup (passwordless) ───────────────────────────────────────────────────

  describe('signup', () => {
    it('creates user and queues verify-OTP when email is new', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(make_user({ email_verified: false }));

      await service.signup({ email: 'NEW@EXAMPLE.COM' });

      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ email: 'new@example.com' }) }),
      );
      // No password column should be touched.
      expect(prisma.user.create.mock.calls[0][0].data).not.toHaveProperty('password_hash');
      expect(redis.set).toHaveBeenCalledWith(
        'auth:otp:verify:new@example.com',
        expect.any(String),
        'EX',
        900,
      );
    });

    it('resends verify-OTP silently when email is registered but unverified', async () => {
      prisma.user.findUnique.mockResolvedValue(make_user({ email_verified: false }));

      await service.signup({ email: 'test@example.com' });

      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(redis.set).toHaveBeenCalled();
    });

    it('silently no-ops when email is already registered AND verified', async () => {
      prisma.user.findUnique.mockResolvedValue(make_user({ email_verified: true }));

      await service.signup({ email: 'test@example.com' });

      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
    });
  });

  // ── verifyEmail ─────────────────────────────────────────────────────────────

  describe('verifyEmail', () => {
    it('marks email verified when OTP matches', async () => {
      const otp = '123456';
      const otp_hash = createHash('sha256').update(otp).digest('hex');

      prisma.user.findUnique.mockResolvedValue(make_user({ email_verified: false }));
      redis.get
        .mockResolvedValueOnce('0')       // attempts
        .mockResolvedValueOnce(otp_hash); // stored hash
      prisma.user.update.mockResolvedValue(make_user());

      await service.verifyEmail({ email: 'test@example.com', otp });

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { email_verified: true } }),
      );
    });

    it('throws AUTH_EMAIL_ALREADY_VERIFIED when already verified', async () => {
      prisma.user.findUnique.mockResolvedValue(make_user({ email_verified: true }));

      await expect(service.verifyEmail({ email: 'test@example.com', otp: '123456' }))
        .rejects.toMatchObject({ code: 'AUTH_EMAIL_ALREADY_VERIFIED' });
    });

    it('throws AUTH_OTP_EXPIRED when OTP not in Redis', async () => {
      prisma.user.findUnique.mockResolvedValue(make_user({ email_verified: false }));
      redis.get
        .mockResolvedValueOnce('0')
        .mockResolvedValueOnce(null);

      await expect(service.verifyEmail({ email: 'test@example.com', otp: '000000' }))
        .rejects.toMatchObject({ code: 'AUTH_OTP_EXPIRED' });
    });

    it('throws AUTH_OTP_MAX_ATTEMPTS after 5 failed attempts', async () => {
      prisma.user.findUnique.mockResolvedValue(make_user({ email_verified: false }));
      redis.get.mockResolvedValueOnce('5');

      await expect(service.verifyEmail({ email: 'test@example.com', otp: '000000' }))
        .rejects.toMatchObject({ code: 'AUTH_OTP_MAX_ATTEMPTS' });
    });
  });

  // ── Passwordless login ──────────────────────────────────────────────────────

  describe('requestLoginOtp', () => {
    it('silently no-ops for unknown email (no leak)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await service.requestLoginOtp('unknown@example.com');
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('silently no-ops for unverified accounts', async () => {
      prisma.user.findUnique.mockResolvedValue(make_user({ email_verified: false }));
      await service.requestLoginOtp('test@example.com');
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('writes login OTP to Redis under the login: namespace', async () => {
      prisma.user.findUnique.mockResolvedValue(make_user());
      await service.requestLoginOtp('TEST@example.com');
      expect(redis.set).toHaveBeenCalledWith(
        'auth:otp:login:test@example.com',
        expect.any(String),
        'EX',
        900,
      );
    });
  });

  describe('verifyLoginOtp', () => {
    it('throws AUTH_OTP_EXPIRED for unknown email', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.verifyLoginOtp({ email: 'x@x.com', otp: '000000' }))
        .rejects.toMatchObject({ code: 'AUTH_OTP_EXPIRED' });
    });

    it('throws AUTH_EMAIL_NOT_VERIFIED for unverified email', async () => {
      prisma.user.findUnique.mockResolvedValue(make_user({ email_verified: false }));
      await expect(service.verifyLoginOtp({ email: 'test@example.com', otp: '000000' }))
        .rejects.toMatchObject({ code: 'AUTH_EMAIL_NOT_VERIFIED' });
    });

    it('throws AUTH_OTP_EXPIRED when no login OTP in Redis', async () => {
      prisma.user.findUnique.mockResolvedValue(make_user());
      redis.get
        .mockResolvedValueOnce('0')   // attempts
        .mockResolvedValueOnce(null); // no stored login OTP

      await expect(service.verifyLoginOtp({ email: 'test@example.com', otp: '000000' }))
        .rejects.toMatchObject({ code: 'AUTH_OTP_EXPIRED' });
    });

    it('mints session on matching OTP — does NOT consult TOTP', async () => {
      const otp = '424242';
      const otp_hash = createHash('sha256').update(otp).digest('hex');
      // 2FA enabled to prove TOTP is intentionally skipped at login.
      prisma.user.findUnique.mockResolvedValue(make_user({ totp_enabled: true, totp_secret: 'enc' }));
      redis.get
        .mockResolvedValueOnce('0')
        .mockResolvedValueOnce(otp_hash);
      session_service.create.mockResolvedValue('session-token');

      const result = await service.verifyLoginOtp({ email: 'test@example.com', otp });

      expect(result).toEqual({ token: 'session-token' });
      // Login OTP key should be cleared after consumption.
      expect(redis.del).toHaveBeenCalledWith('auth:otp:login:test@example.com');
    });
  });

  // ── setup2fa ────────────────────────────────────────────────────────────────

  describe('setup2fa', () => {
    it('throws AUTH_2FA_ALREADY_ENABLED when 2FA is active', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(
        make_user({ totp_enabled: true }),
      );

      await expect(service.setup2fa('user-uuid'))
        .rejects.toMatchObject({ code: 'AUTH_2FA_ALREADY_ENABLED' });
    });

    it('returns secret and QR code URI', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(make_user());
      crypto_service.encrypt.mockReturnValue('encrypted-secret');
      prisma.user.update.mockResolvedValue(make_user());

      const result = await service.setup2fa('user-uuid');

      expect(result.secret).toBeTruthy();
      expect(result.otpauth_url).toContain('otpauth://totp/');
      expect(result.qr_code_uri).toContain('data:image/png;base64,');
    });
  });

  // ── Transaction-PIN OTP delivery (delegated by TransactionPinService) ───────

  describe('sendTransactionPinOtp', () => {
    it('writes a scoped OTP under the user_id namespace', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(make_user());

      await service.sendTransactionPinOtp('user-uuid', 'transaction_pin_set');

      expect(redis.set).toHaveBeenCalledWith(
        'auth:otp:transaction_pin_set:user-uuid',
        expect.any(String),
        'EX',
        900,
      );
    });
  });
});
