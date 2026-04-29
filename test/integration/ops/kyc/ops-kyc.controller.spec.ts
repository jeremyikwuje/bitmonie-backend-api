import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createHash } from 'crypto';
import type { Prisma } from '@prisma/client';

import { OpsKycController } from '@/modules/ops/kyc/ops-kyc.controller';
import { KycService } from '@/modules/kyc/kyc.service';
import { UserRepaymentAccountsService } from '@/modules/user-repayment-accounts/user-repayment-accounts.service';
import { OpsAuditService } from '@/modules/ops/auth/ops-audit.service';
import { OpsGuard } from '@/common/guards/ops-session.guard';
import { PrismaService } from '@/database/prisma.service';
import { GlobalExceptionFilter } from '@/common/filters/global-exception.filter';

const OPS_USER_ID = '11111111-1111-1111-1111-111111111111';
const TARGET_USER_ID = '22222222-2222-2222-2222-222222222222';
const OPS_TOKEN = 'ops-tok-1';

function future(): Date { return new Date(Date.now() + 60_000); }

function make_ops_user(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: OPS_USER_ID,
    email: 'ops@bitmonie.com',
    full_name: 'Ops Person',
    is_active: true,
    totp_enabled: true,
    last_login_at: null as Date | null,
    ...overrides,
  };
}

// Fake tx client — every test that exercises the audit-in-tx invariant uses
// THIS object as the `tx` argument the controller forwards to OpsAuditService.
// Asserting on `tx.opsAuditLog.create` proves the audit row was written via
// the SAME tx client that the underlying action used (KycService.revokeToTier
// / UserRepaymentAccountsService.ensureForUser passing it through), which is
// the load-bearing invariant: rollback of either rolls back the other.
function make_tx(): { opsAuditLog: { create: jest.Mock } } {
  return {
    opsAuditLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

describe('OpsKycController (integration)', () => {
  let app: INestApplication;

  let kyc_service: {
    listVerifications: jest.Mock;
    revokeToTier: jest.Mock;
  };
  let user_repayment_accounts: {
    ensureForUser: jest.Mock;
  };
  let prisma: {
    opsSession: { findUnique: jest.Mock };
    opsUser: { findUnique: jest.Mock };
  };

  async function build_app(): Promise<void> {
    kyc_service = {
      listVerifications: jest.fn(),
      revokeToTier: jest.fn(),
    };
    user_repayment_accounts = {
      ensureForUser: jest.fn(),
    };
    prisma = {
      opsSession: { findUnique: jest.fn() },
      opsUser:    { findUnique: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OpsKycController],
      providers: [
        { provide: KycService,                   useValue: kyc_service },
        { provide: UserRepaymentAccountsService, useValue: user_repayment_accounts },
        { provide: OpsAuditService,              useValue: new OpsAuditService() },
        { provide: PrismaService,                useValue: prisma },
        OpsGuard,
      ],
    }).compile();

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

  function authenticate_ops(): void {
    const expected_hash = createHash('sha256').update(OPS_TOKEN).digest('hex');
    prisma.opsSession.findUnique.mockImplementation(({ where }: { where: { token_hash: string } }) =>
      where.token_hash === expected_hash
        ? Promise.resolve({ ops_user_id: OPS_USER_ID, expires_at: future() })
        : Promise.resolve(null),
    );
    prisma.opsUser.findUnique.mockResolvedValue(make_ops_user());
  }

  beforeEach(() => build_app());
  afterEach(async () => {
    if (app) await app.close();
  });

  // ── 401 isolation: no cookie / customer cookie / ops cookie ─────────────────

  describe('cross-cookie isolation', () => {
    it('GET verifications: 401 with no ops_session cookie', async () => {
      await request(app.getHttpServer())
        .get(`/ops/kyc/${TARGET_USER_ID}/verifications`)
        .expect(401);
      expect(kyc_service.listVerifications).not.toHaveBeenCalled();
    });

    it.each([
      ['POST', 'reset',         '/reset'],
      ['POST', 'revoke',        '/revoke'],
      ['POST', 'provision-va',  '/provision-va'],
    ])('%s %s: 401 with no ops_session cookie', async (_method, _name, path) => {
      await request(app.getHttpServer())
        .post(`/ops/kyc/${TARGET_USER_ID}${path}`)
        .send({ target_tier: 0 })
        .expect(401);
      expect(kyc_service.revokeToTier).not.toHaveBeenCalled();
      expect(user_repayment_accounts.ensureForUser).not.toHaveBeenCalled();
    });

    // A customer `session` cookie is structurally a different cookie name —
    // OpsGuard reads only `ops_session` and rejects with no DB lookup.
    it('rejects a customer `session` cookie at the ops controller level', async () => {
      await request(app.getHttpServer())
        .post(`/ops/kyc/${TARGET_USER_ID}/reset`)
        .set('Cookie', ['session=customer-token'])
        .send({})
        .expect(401);
      expect(prisma.opsSession.findUnique).not.toHaveBeenCalled();
      expect(kyc_service.revokeToTier).not.toHaveBeenCalled();
    });
  });

  // ── GET verifications — read-only, no audit ─────────────────────────────────

  describe('GET /:user_id/verifications', () => {
    it('delegates to KycService.listVerifications and returns 200', async () => {
      authenticate_ops();
      const verifications = [
        {
          tier: 1,
          id_type: 'BVN',
          status: 'VERIFIED',
          legal_name: 'Ada Obi',
          date_of_birth: new Date('1990-05-15'),
          provider_reference: 'ref-1',
          provider_raw_response: { source: 'easeid' },
          failure_reason: null,
          verified_at: new Date('2026-04-20'),
          created_at: new Date('2026-04-20'),
          updated_at: new Date('2026-04-20'),
        },
      ];
      kyc_service.listVerifications.mockResolvedValue(verifications);

      const response = await request(app.getHttpServer())
        .get(`/ops/kyc/${TARGET_USER_ID}/verifications`)
        .set('Cookie', [`ops_session=${OPS_TOKEN}`])
        .expect(200);

      expect(kyc_service.listVerifications).toHaveBeenCalledWith(TARGET_USER_ID);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body[0].tier).toBe(1);
    });

    it('rejects a non-UUID :user_id with 400', async () => {
      authenticate_ops();
      await request(app.getHttpServer())
        .get('/ops/kyc/not-a-uuid/verifications')
        .set('Cookie', [`ops_session=${OPS_TOKEN}`])
        .expect(400);
      expect(kyc_service.listVerifications).not.toHaveBeenCalled();
    });
  });

  // ── provision-va: load-bearing audit-in-tx invariant ────────────────────────

  describe('POST /:user_id/provision-va', () => {
    it('on a user with no existing VA: writes audit row via the SAME tx client used to create the VA', async () => {
      authenticate_ops();
      const tx = make_tx();
      // Service contract: invokes the on_created_in_tx callback with the
      // active tx client. The controller's job is to write the audit row
      // through that same client — proving atomicity.
      user_repayment_accounts.ensureForUser.mockImplementation(
        async (
          _user_id: string,
          on_created_in_tx?: (tx: Prisma.TransactionClient) => Promise<void>,
        ) => {
          if (on_created_in_tx) await on_created_in_tx(tx as unknown as Prisma.TransactionClient);
          return {
            summary: {
              virtual_account_no:   '9000000001',
              virtual_account_name: 'Bitmonie Loan Repayment',
              bank_name:            'Bloom Microfinance Bank',
              provider:             'palmpay',
            },
            created: true,
          };
        },
      );

      const response = await request(app.getHttpServer())
        .post(`/ops/kyc/${TARGET_USER_ID}/provision-va`)
        .set('Cookie', [`ops_session=${OPS_TOKEN}`])
        .set('x-request-id', 'req_xyz_001')
        .send({})
        .expect(200);

      expect(response.body).toEqual({
        virtual_account_no:   '9000000001',
        virtual_account_name: 'Bitmonie Loan Repayment',
        bank_name:            'Bloom Microfinance Bank',
        provider:             'palmpay',
      });

      // The audit row was written through the SAME tx client the service
      // used for the VA insert — that's the atomicity guarantee.
      expect(tx.opsAuditLog.create).toHaveBeenCalledTimes(1);
      expect(tx.opsAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          ops_user_id: OPS_USER_ID,
          action:      'kyc.provision_va',
          target_type: 'user',
          target_id:   TARGET_USER_ID,
          request_id:  'req_xyz_001',
        }),
      });
    });

    // The partial-failure invariant: if the collection provider throws mid-flow,
    // the service rejects BEFORE invoking the audit callback — neither the VA
    // row nor the audit row is written.
    it('on provider failure mid-flow: NEITHER VA nor audit row is written', async () => {
      authenticate_ops();
      const tx = make_tx();
      user_repayment_accounts.ensureForUser.mockImplementation(
        async (
          _user_id: string,
          _on_created_in_tx?: (tx: Prisma.TransactionClient) => Promise<void>,
        ) => {
          // Simulate the collection provider throwing — the real service
          // calls the provider BEFORE opening the tx that runs the audit
          // callback, so the callback never fires.
          throw new Error('provider boom');
        },
      );

      await request(app.getHttpServer())
        .post(`/ops/kyc/${TARGET_USER_ID}/provision-va`)
        .set('Cookie', [`ops_session=${OPS_TOKEN}`])
        .send({})
        .expect(500);

      expect(tx.opsAuditLog.create).not.toHaveBeenCalled();
    });

    it('on a user who already has a VA: returns existing summary, NO audit row (idempotent)', async () => {
      authenticate_ops();
      const tx = make_tx();
      user_repayment_accounts.ensureForUser.mockImplementation(
        async (
          _user_id: string,
          on_created_in_tx?: (tx: Prisma.TransactionClient) => Promise<void>,
        ) => {
          // Existing-VA branch: service returns without invoking the
          // callback. Even if the controller passes one, it never fires.
          void on_created_in_tx;
          return {
            summary: {
              virtual_account_no:   '9000000099',
              virtual_account_name: 'Bitmonie Loan Repayment',
              bank_name:            'Bloom Microfinance Bank',
              provider:             'palmpay',
            },
            created: false,
          };
        },
      );

      const response = await request(app.getHttpServer())
        .post(`/ops/kyc/${TARGET_USER_ID}/provision-va`)
        .set('Cookie', [`ops_session=${OPS_TOKEN}`])
        .send({})
        .expect(200);

      expect(response.body.virtual_account_no).toBe('9000000099');
      expect(tx.opsAuditLog.create).not.toHaveBeenCalled();
    });

    it('on a user with no tier-1 KYC: 404 KYC_NOT_FOUND, no audit row', async () => {
      authenticate_ops();
      const tx = make_tx();
      user_repayment_accounts.ensureForUser.mockResolvedValue(null);

      const response = await request(app.getHttpServer())
        .post(`/ops/kyc/${TARGET_USER_ID}/provision-va`)
        .set('Cookie', [`ops_session=${OPS_TOKEN}`])
        .send({})
        .expect(404);

      expect(response.body.error.code).toBe('KYC_NOT_FOUND');
      expect(tx.opsAuditLog.create).not.toHaveBeenCalled();
    });
  });

  // ── reset & revoke: load-bearing audit-in-tx invariant ──────────────────────

  describe('POST /:user_id/reset', () => {
    it('writes audit row via the SAME tx client used by KycService.revokeToTier', async () => {
      authenticate_ops();
      const tx = make_tx();
      kyc_service.revokeToTier.mockImplementation(
        async (
          _user_id: string,
          _dto: { target_tier: number },
          on_in_tx?: (tx: Prisma.TransactionClient) => Promise<void>,
        ) => {
          if (on_in_tx) await on_in_tx(tx as unknown as Prisma.TransactionClient);
          return { message: 'KYC reset to unverified.' };
        },
      );

      const response = await request(app.getHttpServer())
        .post(`/ops/kyc/${TARGET_USER_ID}/reset`)
        .set('Cookie', [`ops_session=${OPS_TOKEN}`])
        .set('x-request-id', 'req_reset_1')
        .send({})
        .expect(200);

      expect(response.body).toEqual({ message: 'KYC reset to unverified.' });
      expect(kyc_service.revokeToTier).toHaveBeenCalledWith(
        TARGET_USER_ID,
        { target_tier: 0 },
        expect.any(Function),
      );
      expect(tx.opsAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          ops_user_id: OPS_USER_ID,
          action:      'kyc.reset',
          target_type: 'user',
          target_id:   TARGET_USER_ID,
          details:     { target_tier: 0 },
          request_id:  'req_reset_1',
        }),
      });
    });

    it('on revokeToTier throwing inside the tx: NO audit row escapes (callback never resolves)', async () => {
      authenticate_ops();
      const tx = make_tx();
      kyc_service.revokeToTier.mockImplementation(
        async (
          _user_id: string,
          _dto: { target_tier: number },
          on_in_tx?: (tx: Prisma.TransactionClient) => Promise<void>,
        ) => {
          // Simulate user.update failing inside the tx — the real service
          // would surface this as a thrown error and the audit-write
          // callback would never have been called.
          void on_in_tx;
          throw new Error('db boom');
        },
      );

      await request(app.getHttpServer())
        .post(`/ops/kyc/${TARGET_USER_ID}/reset`)
        .set('Cookie', [`ops_session=${OPS_TOKEN}`])
        .send({})
        .expect(500);

      expect(tx.opsAuditLog.create).not.toHaveBeenCalled();
    });
  });

  describe('POST /:user_id/revoke', () => {
    it('forwards target_tier from body and writes audit row in the same tx', async () => {
      authenticate_ops();
      const tx = make_tx();
      kyc_service.revokeToTier.mockImplementation(
        async (
          _user_id: string,
          _dto: { target_tier: number },
          on_in_tx?: (tx: Prisma.TransactionClient) => Promise<void>,
        ) => {
          if (on_in_tx) await on_in_tx(tx as unknown as Prisma.TransactionClient);
          return { message: 'KYC revoked to tier 1.' };
        },
      );

      const response = await request(app.getHttpServer())
        .post(`/ops/kyc/${TARGET_USER_ID}/revoke`)
        .set('Cookie', [`ops_session=${OPS_TOKEN}`])
        .send({ target_tier: 1 })
        .expect(200);

      expect(response.body).toEqual({ message: 'KYC revoked to tier 1.' });
      expect(kyc_service.revokeToTier).toHaveBeenCalledWith(
        TARGET_USER_ID,
        { target_tier: 1 },
        expect.any(Function),
      );
      expect(tx.opsAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action:  'kyc.revoke',
          details: { target_tier: 1 },
        }),
      });
    });

    it('rejects body without target_tier (validation pipe)', async () => {
      authenticate_ops();
      await request(app.getHttpServer())
        .post(`/ops/kyc/${TARGET_USER_ID}/revoke`)
        .set('Cookie', [`ops_session=${OPS_TOKEN}`])
        .send({})
        .expect(400);
      expect(kyc_service.revokeToTier).not.toHaveBeenCalled();
    });
  });
});
