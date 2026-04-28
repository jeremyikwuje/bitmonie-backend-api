import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createHash } from 'crypto';
import type { Prisma } from '@prisma/client';

import { OpsDisbursementsController } from '@/modules/ops/disbursements/ops-disbursements.controller';
import { OpsDisbursementsService } from '@/modules/ops/disbursements/ops-disbursements.service';
import { OpsAuditService } from '@/modules/ops/auth/ops-audit.service';
import { OpsGuard } from '@/common/guards/ops-session.guard';
import { OutflowsService } from '@/modules/disbursements/outflows.service';
import { DisbursementsService } from '@/modules/disbursements/disbursements.service';
import { PrismaService } from '@/database/prisma.service';
import { GlobalExceptionFilter } from '@/common/filters/global-exception.filter';
import { OPS_ACTION, OPS_TARGET_TYPE } from '@/common/constants/ops-actions';

const OPS_USER_ID    = '11111111-1111-1111-1111-111111111111';
const DISBURSEMENT_ID = '22222222-2222-2222-2222-222222222222';
const OPS_TOKEN      = 'ops-tok-disb';

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

// Fake tx client — controllers/services that perform audited writes pass this
// through to OpsAuditService.write. Asserting on `tx.opsAuditLog.create`
// proves the audit row was written via the SAME client used by the action,
// which is the load-bearing invariant: rollback of either rolls back the other.
function make_tx(): { opsAuditLog: { create: jest.Mock } } {
  return { opsAuditLog: { create: jest.fn().mockResolvedValue({}) } };
}

describe('OpsDisbursementsController (integration)', () => {
  let app: INestApplication;

  let prisma: {
    opsSession:    { findUnique: jest.Mock };
    opsUser:       { findUnique: jest.Mock };
    disbursement:  { findMany: jest.Mock; findUnique: jest.Mock };
    $transaction:  jest.Mock;
  };
  let outflows: { retryDispatch: jest.Mock };
  let disbursements: { findById: jest.Mock; markCancelled: jest.Mock };

  async function build_app(): Promise<void> {
    prisma = {
      opsSession:   { findUnique: jest.fn() },
      opsUser:      { findUnique: jest.fn() },
      disbursement: { findMany: jest.fn(), findUnique: jest.fn() },
      $transaction: jest.fn(),
    };
    outflows = { retryDispatch: jest.fn() };
    disbursements = { findById: jest.fn(), markCancelled: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OpsDisbursementsController],
      providers: [
        OpsDisbursementsService,
        { provide: PrismaService,        useValue: prisma },
        { provide: OutflowsService,      useValue: outflows },
        { provide: DisbursementsService, useValue: disbursements },
        { provide: OpsAuditService,      useValue: new OpsAuditService() },
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

  // ── 401 isolation ──────────────────────────────────────────────────────────

  describe('cross-cookie isolation', () => {
    it('GET list: 401 with no ops_session cookie', async () => {
      await request(app.getHttpServer()).get('/ops/disbursements').expect(401);
      expect(prisma.disbursement.findMany).not.toHaveBeenCalled();
    });

    it('rejects a customer `session` cookie', async () => {
      await request(app.getHttpServer())
        .post(`/ops/disbursements/${DISBURSEMENT_ID}/retry`)
        .set('Cookie', ['session=customer-token'])
        .expect(401);
      expect(prisma.opsSession.findUnique).not.toHaveBeenCalled();
    });
  });

  // ── GET / list ─────────────────────────────────────────────────────────────

  describe('GET /', () => {
    it('defaults the status filter to ON_HOLD and returns cursor + summaries', async () => {
      authenticate_ops();
      const ts = new Date('2026-04-25T10:00:00Z');
      prisma.disbursement.findMany.mockResolvedValue([
        {
          id:             DISBURSEMENT_ID,
          user_id:        'user-001',
          status:         'ON_HOLD',
          amount:         { toString: () => '300000' },
          currency:       'NGN',
          source_type:    'LOAN',
          source_id:      'loan-001',
          on_hold_at:     ts,
          failure_reason: 'Bank declined',
          created_at:     ts,
          outflows:       [{ attempt_number: 1 }],
        },
      ]);

      const res = await request(app.getHttpServer())
        .get('/ops/disbursements')
        .set('Cookie', [`ops_session=${OPS_TOKEN}`])
        .expect(200);

      expect(prisma.disbursement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'ON_HOLD' } }),
      );
      expect(res.body.rows).toHaveLength(1);
      expect(res.body.rows[0]).toMatchObject({
        id:             DISBURSEMENT_ID,
        status:         'ON_HOLD',
        attempt_count:  1,
      });
      expect(res.body.next_cursor).toBeNull();
    });

    it('rejects an invalid status filter with 400', async () => {
      authenticate_ops();
      await request(app.getHttpServer())
        .get('/ops/disbursements?status=NOT_A_REAL_STATUS')
        .set('Cookie', [`ops_session=${OPS_TOKEN}`])
        .expect(400);
      expect(prisma.disbursement.findMany).not.toHaveBeenCalled();
    });
  });

  // ── POST /:id/retry — audit written + retry dispatched ─────────────────────

  describe('POST /:disbursement_id/retry', () => {
    it('writes audit row in tx and calls OutflowsService.retryDispatch', async () => {
      authenticate_ops();
      const tx = make_tx();
      disbursements.findById.mockResolvedValue({
        id: DISBURSEMENT_ID,
        status: 'ON_HOLD',
        outflows: [{ attempt_number: 1 }],
      });
      prisma.$transaction.mockImplementation(async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
        return fn(tx as unknown as Prisma.TransactionClient);
      });
      outflows.retryDispatch.mockResolvedValue(undefined);

      await request(app.getHttpServer())
        .post(`/ops/disbursements/${DISBURSEMENT_ID}/retry`)
        .set('Cookie', [`ops_session=${OPS_TOKEN}`])
        .set('x-request-id', 'req_xyz_001')
        .expect(202);

      expect(tx.opsAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          ops_user_id: OPS_USER_ID,
          action:      OPS_ACTION.DISBURSEMENT_RETRY,
          target_type: OPS_TARGET_TYPE.DISBURSEMENT,
          target_id:   DISBURSEMENT_ID,
          request_id:  'req_xyz_001',
        }),
      });
      expect(outflows.retryDispatch).toHaveBeenCalledWith(DISBURSEMENT_ID);
    });

    it('returns 404 when the disbursement does not exist', async () => {
      authenticate_ops();
      disbursements.findById.mockResolvedValue(null);
      await request(app.getHttpServer())
        .post(`/ops/disbursements/${DISBURSEMENT_ID}/retry`)
        .set('Cookie', [`ops_session=${OPS_TOKEN}`])
        .expect(404);
      expect(outflows.retryDispatch).not.toHaveBeenCalled();
    });
  });

  // ── POST /:id/cancel — atomic markCancelled + audit ────────────────────────

  describe('POST /:disbursement_id/cancel', () => {
    it('cancels the disbursement and writes an audit row via the SAME tx client', async () => {
      authenticate_ops();
      const tx = make_tx();
      disbursements.findById.mockResolvedValue({
        id: DISBURSEMENT_ID,
        status: 'ON_HOLD',
        outflows: [{ attempt_number: 1 }],
      });
      prisma.$transaction.mockImplementation(async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
        return fn(tx as unknown as Prisma.TransactionClient);
      });
      // Service receives the SAME tx and forwards it to markCancelled.
      disbursements.markCancelled.mockResolvedValue({ id: DISBURSEMENT_ID, status: 'CANCELLED' });

      await request(app.getHttpServer())
        .post(`/ops/disbursements/${DISBURSEMENT_ID}/cancel`)
        .set('Cookie', [`ops_session=${OPS_TOKEN}`])
        .set('x-request-id', 'req_cancel_001')
        .send({ reason: 'Wrong account number — customer confirmed' })
        .expect(200);

      expect(disbursements.markCancelled).toHaveBeenCalledWith(
        expect.objectContaining({
          disbursement_id:          DISBURSEMENT_ID,
          cancelled_by_ops_user_id: OPS_USER_ID,
          cancellation_reason:      'Wrong account number — customer confirmed',
        }),
        tx,
      );
      expect(tx.opsAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          ops_user_id: OPS_USER_ID,
          action:      OPS_ACTION.DISBURSEMENT_CANCEL,
          target_type: OPS_TARGET_TYPE.DISBURSEMENT,
          target_id:   DISBURSEMENT_ID,
          request_id:  'req_cancel_001',
        }),
      });
    });

    it('rejects cancellation of an already-SUCCESSFUL disbursement with 409', async () => {
      authenticate_ops();
      disbursements.findById.mockResolvedValue({
        id: DISBURSEMENT_ID,
        status: 'SUCCESSFUL',
        outflows: [{ attempt_number: 1 }],
      });
      await request(app.getHttpServer())
        .post(`/ops/disbursements/${DISBURSEMENT_ID}/cancel`)
        .set('Cookie', [`ops_session=${OPS_TOKEN}`])
        .send({ reason: 'Too late — but still tried' })
        .expect(409);
      expect(disbursements.markCancelled).not.toHaveBeenCalled();
    });

    it('rejects an empty reason with 400', async () => {
      authenticate_ops();
      await request(app.getHttpServer())
        .post(`/ops/disbursements/${DISBURSEMENT_ID}/cancel`)
        .set('Cookie', [`ops_session=${OPS_TOKEN}`])
        .send({ reason: 'x' }) // shorter than min length
        .expect(400);
      expect(disbursements.markCancelled).not.toHaveBeenCalled();
    });
  });
});
