// Mock ESM-only / native deps before any import that transitively pulls
// `ops-auth.service.ts` (which imports otplib, which is ESM-only).
jest.mock('argon2', () => ({
  hash: jest.fn().mockResolvedValue('$argon2id$mock'),
  verify: jest.fn().mockResolvedValue(false),
}));
jest.mock('otplib', () => ({
  generateSecret: jest.fn().mockReturnValue('BASE32OPSSECRET'),
  verify: jest.fn().mockResolvedValue({ valid: true, delta: 0 }),
  generateURI: jest.fn().mockReturnValue('otpauth://totp/x?secret=BASE32OPSSECRET'),
}));
jest.mock('qrcode', () => ({
  toDataURL: jest.fn().mockResolvedValue('data:image/png;base64,MOCK'),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createHash } from 'crypto';
import { OpsAuthController } from '@/modules/ops/auth/ops-auth.controller';
import { OpsAuthService } from '@/modules/ops/auth/ops-auth.service';
import { OpsGuard } from '@/common/guards/ops-session.guard';
import { PrismaService } from '@/database/prisma.service';
import { GlobalExceptionFilter } from '@/common/filters/global-exception.filter';
import {
  OpsInvalidCredentialsException,
  OpsTwoFactorEnrolmentRequiredException,
  OpsTwoFactorInvalidException,
  OpsTwoFactorRequiredException,
} from '@/common/errors/bitmonie.errors';

function future(): Date { return new Date(Date.now() + 60_000); }

function make_ops_user(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ops-uuid',
    email: 'ops@bitmonie.com',
    full_name: 'Ops Person',
    is_active: true,
    totp_enabled: true,
    last_login_at: null as Date | null,
    ...overrides,
  };
}

describe('OpsAuthController (integration)', () => {
  let app: INestApplication;
  let ops_auth_service: {
    login: jest.Mock;
    verifyTwoFactor: jest.Mock;
    startEnrolment: jest.Mock;
    confirmEnrolment: jest.Mock;
    logout: jest.Mock;
  };
  let prisma: {
    opsSession: { findUnique: jest.Mock };
    opsUser: { findUnique: jest.Mock };
  };

  async function build_app(opts: { with_throttle?: boolean } = {}): Promise<void> {
    ops_auth_service = {
      login: jest.fn(),
      verifyTwoFactor: jest.fn(),
      startEnrolment: jest.fn(),
      confirmEnrolment: jest.fn(),
      logout: jest.fn(),
    };
    prisma = {
      opsSession: { findUnique: jest.fn() },
      opsUser: { findUnique: jest.fn() },
    };

    const builder = Test.createTestingModule({
      imports: opts.with_throttle
        ? [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 60 }])]
        : [],
      controllers: [OpsAuthController],
      providers: [
        { provide: OpsAuthService, useValue: ops_auth_service },
        { provide: PrismaService, useValue: prisma },
        OpsGuard,
        ...(opts.with_throttle
          ? [{ provide: APP_GUARD, useClass: ThrottlerGuard }]
          : []),
      ],
    });

    const module: TestingModule = await builder.compile();

    app = module.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }));
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  }

  afterEach(async () => {
    if (app) await app.close();
  });

  // ── Two-step login: cookie only on step 2 (load-bearing) ────────────────────

  describe('two-step login', () => {
    beforeEach(() => build_app());

    it('step 1 returns 202 + challenge_id without setting ops_session cookie', async () => {
      ops_auth_service.login.mockRejectedValue(
        new OpsTwoFactorRequiredException({ challenge_id: 'chal-123' }),
      );

      const response = await request(app.getHttpServer())
        .post('/ops/auth/login')
        .send({ email: 'ops@bitmonie.com', password: 'pw' })
        .expect(202);

      expect(response.body).toEqual({ challenge_id: 'chal-123' });
      // Critical: no Set-Cookie header on step 1
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('step 2 sets ops_session cookie ONLY on valid TOTP', async () => {
      ops_auth_service.verifyTwoFactor.mockResolvedValue({ token: 'session-token-abc' });

      const response = await request(app.getHttpServer())
        .post('/ops/auth/verify-2fa')
        .send({ challenge_id: 'chal-123', totp_code: '111111' })
        .expect(200);

      expect(response.body).toMatchObject({
        message: 'Logged in.',
        token: 'session-token-abc',
        expires_in: 28_800,
      });

      const cookies = response.headers['set-cookie'] as unknown as string[] | undefined;
      expect(cookies).toBeDefined();
      const ops_cookie = cookies!.find((c) => c.startsWith('ops_session='));
      expect(ops_cookie).toBeDefined();
      expect(ops_cookie).toContain('HttpOnly');
    });

    it('step 2 with invalid TOTP returns 401 and does NOT set cookie', async () => {
      ops_auth_service.verifyTwoFactor.mockRejectedValue(new OpsTwoFactorInvalidException());

      const response = await request(app.getHttpServer())
        .post('/ops/auth/verify-2fa')
        .send({ challenge_id: 'chal-123', totp_code: '999999' })
        .expect(401);

      expect(response.body.error.code).toBe('OPS_2FA_INVALID');
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('login with bad credentials returns 401 OPS_INVALID_CREDENTIALS, no cookie', async () => {
      ops_auth_service.login.mockRejectedValue(new OpsInvalidCredentialsException());

      const response = await request(app.getHttpServer())
        .post('/ops/auth/login')
        .send({ email: 'ops@bitmonie.com', password: 'wrong' })
        .expect(401);

      expect(response.body.error.code).toBe('OPS_INVALID_CREDENTIALS');
      expect(response.headers['set-cookie']).toBeUndefined();
    });
  });

  // ── First-time login: enrolment required, then enrol-2fa flips totp_enabled ─

  describe('first-time login enrolment flow', () => {
    beforeEach(() => build_app());

    it('login with totp_enabled=false returns 403 OPS_2FA_ENROLMENT_REQUIRED', async () => {
      ops_auth_service.login.mockRejectedValue(
        new OpsTwoFactorEnrolmentRequiredException({ enrolment_token: 'enrol-tok' }),
      );

      const response = await request(app.getHttpServer())
        .post('/ops/auth/login')
        .send({ email: 'ops@bitmonie.com', password: 'pw' })
        .expect(403);

      expect(response.body.error.code).toBe('OPS_2FA_ENROLMENT_REQUIRED');
      expect(response.body.error.details).toEqual([
        { field: 'enrolment_token', issue: 'enrol-tok' },
      ]);
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('start-enrolment with valid token returns TOTP secret + QR + otpauth url, no cookie', async () => {
      ops_auth_service.startEnrolment.mockResolvedValue({
        secret: 'BASE32OPSSECRET',
        qr_code_uri: 'data:image/png;base64,MOCK',
        otpauth_url: 'otpauth://totp/x?secret=BASE32OPSSECRET',
      });

      const response = await request(app.getHttpServer())
        .post('/ops/auth/start-enrolment')
        .send({ enrolment_token: 'enrol-tok' })
        .expect(200);

      expect(response.body).toEqual({
        secret: 'BASE32OPSSECRET',
        qr_code_uri: 'data:image/png;base64,MOCK',
        otpauth_url: 'otpauth://totp/x?secret=BASE32OPSSECRET',
      });
      expect(ops_auth_service.startEnrolment).toHaveBeenCalledWith({ enrolment_token: 'enrol-tok' });
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('start-enrolment with stale token returns 401, no secret leaked', async () => {
      ops_auth_service.startEnrolment.mockRejectedValue(new OpsTwoFactorInvalidException());

      const response = await request(app.getHttpServer())
        .post('/ops/auth/start-enrolment')
        .send({ enrolment_token: 'stale' })
        .expect(401);

      expect(response.body.error.code).toBe('OPS_2FA_INVALID');
      expect(response.body.secret).toBeUndefined();
    });

    it('enrol-2fa with valid TOTP issues a session and sets ops_session cookie', async () => {
      // The service contract for confirmEnrolment is the load-bearing piece:
      // a successful call flips totp_enabled in the DB and returns a session
      // token. The controller's job is just to surface that as a Set-Cookie.
      ops_auth_service.confirmEnrolment.mockResolvedValue({ token: 'first-session-token' });

      const response = await request(app.getHttpServer())
        .post('/ops/auth/enrol-2fa')
        .send({ enrolment_token: 'enrol-tok', totp_code: '123456' })
        .expect(200);

      expect(response.body).toMatchObject({
        message: '2FA enrolled.',
        token: 'first-session-token',
        expires_in: 28_800,
      });

      expect(ops_auth_service.confirmEnrolment).toHaveBeenCalledWith(
        expect.objectContaining({
          enrolment_token: 'enrol-tok',
          totp_code: '123456',
        }),
      );

      const cookies = response.headers['set-cookie'] as unknown as string[] | undefined;
      expect(cookies).toBeDefined();
      expect(cookies!.find((c) => c.startsWith('ops_session='))).toBeDefined();
    });

    it('enrol-2fa with stale enrolment_token returns 401, no cookie', async () => {
      ops_auth_service.confirmEnrolment.mockRejectedValue(new OpsTwoFactorInvalidException());

      const response = await request(app.getHttpServer())
        .post('/ops/auth/enrol-2fa')
        .send({ enrolment_token: 'stale', totp_code: '123456' })
        .expect(401);

      expect(response.body.error.code).toBe('OPS_2FA_INVALID');
      expect(response.headers['set-cookie']).toBeUndefined();
    });
  });

  // ── Logout invalidates session row (load-bearing) ───────────────────────────

  describe('logout', () => {
    beforeEach(() => build_app());

    it('clears ops_session cookie and asks the service to destroy the session', async () => {
      // Guard prerequisites: a valid ops_session row + active ops_user
      const token = 'tok-to-revoke';
      const expected_hash = createHash('sha256').update(token).digest('hex');
      prisma.opsSession.findUnique.mockResolvedValue({
        ops_user_id: 'ops-uuid',
        expires_at: future(),
      });
      prisma.opsUser.findUnique.mockResolvedValue(make_ops_user());

      const response = await request(app.getHttpServer())
        .post('/ops/auth/logout')
        .set('Cookie', [`ops_session=${token}`])
        .expect(200);

      expect(response.body).toEqual({ message: 'Logged out.' });
      // The service hashes internally; this asserts the bare token reached it.
      expect(ops_auth_service.logout).toHaveBeenCalledWith(token);
      expect(prisma.opsSession.findUnique).toHaveBeenCalledWith({
        where: { token_hash: expected_hash },
      });

      const cookies = response.headers['set-cookie'] as unknown as string[] | undefined;
      expect(cookies).toBeDefined();
      const cleared = cookies!.find((c) => c.startsWith('ops_session='));
      expect(cleared).toBeDefined();
      // express clearCookie sets an empty value with an Expires in the past
      expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
    });

    it('rejects with 401 when the session row is gone (mirrors revoked session)', async () => {
      // Same cookie value, but the underlying session row no longer exists —
      // exactly the state after a successful logout. OpsGuard rejects.
      prisma.opsSession.findUnique.mockResolvedValue(null);

      await request(app.getHttpServer())
        .post('/ops/auth/logout')
        .set('Cookie', [`ops_session=already-revoked`])
        .expect(401);
    });

    it('logout without ops_session cookie returns 401', async () => {
      await request(app.getHttpServer())
        .post('/ops/auth/logout')
        .expect(401);
    });
  });

  // ── /me ─────────────────────────────────────────────────────────────────────

  describe('GET /me', () => {
    beforeEach(() => build_app());

    it('returns the authenticated ops user profile', async () => {
      prisma.opsSession.findUnique.mockResolvedValue({
        ops_user_id: 'ops-uuid',
        expires_at: future(),
      });
      const last_login_at = new Date('2026-04-26T10:00:00Z');
      prisma.opsUser.findUnique.mockResolvedValue(
        make_ops_user({ last_login_at }),
      );

      const response = await request(app.getHttpServer())
        .get('/ops/auth/me')
        .set('Cookie', ['ops_session=tok'])
        .expect(200);

      expect(response.body).toEqual({
        id: 'ops-uuid',
        email: 'ops@bitmonie.com',
        full_name: 'Ops Person',
        last_login_at: last_login_at.toISOString(),
      });
    });

    it('rejects with 401 when no cookie present', async () => {
      await request(app.getHttpServer())
        .get('/ops/auth/me')
        .expect(401);
    });
  });

  // ── Throttle: 6th login attempt within 60s from one IP fails (load-bearing) ─

  describe('throttle', () => {
    beforeEach(() => build_app({ with_throttle: true }));

    it('5 login attempts in <60s succeed with 401, the 6th is rate-limited (429)', async () => {
      // The service rejects every attempt — what we care about is the guard
      // enforcing the 5/min limit at the controller level, not the service.
      ops_auth_service.login.mockRejectedValue(new OpsInvalidCredentialsException());

      for (let i = 0; i < 5; i++) {
        await request(app.getHttpServer())
          .post('/ops/auth/login')
          .send({ email: 'ops@bitmonie.com', password: 'wrong' })
          .expect(401);
      }

      await request(app.getHttpServer())
        .post('/ops/auth/login')
        .send({ email: 'ops@bitmonie.com', password: 'wrong' })
        .expect(429);
    });
  });
});
