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
    disbursement:  { findMany: jest.Mock; findUnique: jest.Mock; findFirst: jest.Mock };
    loan:          { findUnique: jest.Mock };
    $transaction:  jest.Mock;
  };
  let outflows: { retryDispatch: jest.Mock; handleFailure: jest.Mock; dispatch: jest.Mock };
  let disbursements: { findById: jest.Mock; markCancelled: jest.Mock; createForLoan: jest.Mock };

  async function build_app(): Promise<void> {
    prisma = {
      opsSession:   { findUnique: jest.fn() },
      opsUser:      { findUnique: jest.fn() },
      disbursement: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn() },
      loan:         { findUnique: jest.fn() },
      $transaction: jest.fn(),
    };
    outflows = { retryDispatch: jest.fn(), handleFailure: jest.fn(), dispatch: jest.fn() };
    disbursements = { findById: jest.fn(), markCancelled: jest.fn(), createForLoan: jest.fn() };

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
    it('returns all statuses by default (no implicit status filter) and returns cursor + summaries', async () => {
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

      // No `status` query param → no implicit status filter (Prisma `where: { status: undefined }`
      // is equivalent to "all rows"); ops can pass ?status=ON_HOLD explicitly to scope the queue.
      expect(prisma.disbursement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: undefined } }),
      );
      expect(res.body.rows).toHaveLength(1);
      expect(res.body.rows[0]).toMatchObject({
        id:             DISBURSEMENT_ID,
        status:         'ON_HOLD',
        attempt_count:  1,
      });
      expect(res.body.next_cursor).toBeNull();
    });

    it('applies an explicit status filter when ?status= is passed', async () => {
      authenticate_ops();
      prisma.disbursement.findMany.mockResolvedValue([]);

      await request(app.getHttpServer())
        .get('/ops/disbursements?status=ON_HOLD')
        .set('Cookie', [`ops_session=${OPS_TOKEN}`])
        .expect(200);

      expect(prisma.disbursement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'ON_HOLD' } }),
      );
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

  // ── POST /:id/abandon-attempt — atomic audit + force outflow failure ───────

  describe('POST /:disbursement_id/abandon-attempt', () => {
    it('writes audit row in tx then routes the active outflow through OutflowsService.handleFailure with OPS_ABANDONED', async () => {
      authenticate_ops();
      const tx = make_tx();
      const ACTIVE_OUTFLOW_ID = 'outflow-active-001';
      disbursements.findById.mockResolvedValue({
        id: DISBURSEMENT_ID,
        status: 'PROCESSING',
        outflows: [
          // Old failed attempt should be ignored
          { id: 'outflow-old-001', attempt_number: 1, status: 'FAILED' },
          // The current in-flight outflow that abandon should target
          { id: ACTIVE_OUTFLOW_ID, attempt_number: 2, status: 'PROCESSING' },
        ],
      });
      prisma.$transaction.mockImplementation(async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
        return fn(tx as unknown as Prisma.TransactionClient);
      });

      await request(app.getHttpServer())
        .post(`/ops/disbursements/${DISBURSEMENT_ID}/abandon-attempt`)
        .set('Cookie', [`ops_session=${OPS_TOKEN}`])
        .set('x-request-id', 'req_abandon_001')
        .send({ reason: 'Stub provider stuck — switching to PalmPay' })
        .expect(200);

      expect(tx.opsAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          ops_user_id: OPS_USER_ID,
          action:      OPS_ACTION.DISBURSEMENT_ABANDON_ATTEMPT,
          target_type: OPS_TARGET_TYPE.DISBURSEMENT,
          target_id:   DISBURSEMENT_ID,
          request_id:  'req_abandon_001',
        }),
      });
      // Only the active outflow gets failed — past failures stay immutable.
      expect(outflows.handleFailure).toHaveBeenCalledTimes(1);
      expect(outflows.handleFailure).toHaveBeenCalledWith(
        ACTIVE_OUTFLOW_ID,
        DISBURSEMENT_ID,
        'Stub provider stuck — switching to PalmPay',
        'OPS_ABANDONED',
      );
    });

    it('returns 409 when there is no active outflow to abandon', async () => {
      authenticate_ops();
      disbursements.findById.mockResolvedValue({
        id: DISBURSEMENT_ID,
        status: 'PROCESSING',
        outflows: [{ id: 'outflow-old', attempt_number: 1, status: 'FAILED' }],
      });
      await request(app.getHttpServer())
        .post(`/ops/disbursements/${DISBURSEMENT_ID}/abandon-attempt`)
        .set('Cookie', [`ops_session=${OPS_TOKEN}`])
        .send({ reason: 'Trying to abandon nothing' })
        .expect(409);
      expect(outflows.handleFailure).not.toHaveBeenCalled();
    });

    it('returns 409 when the disbursement is already terminal (SUCCESSFUL)', async () => {
      authenticate_ops();
      disbursements.findById.mockResolvedValue({
        id: DISBURSEMENT_ID,
        status: 'SUCCESSFUL',
        outflows: [{ id: 'outflow-001', attempt_number: 1, status: 'PROCESSING' }],
      });
      await request(app.getHttpServer())
        .post(`/ops/disbursements/${DISBURSEMENT_ID}/abandon-attempt`)
        .set('Cookie', [`ops_session=${OPS_TOKEN}`])
        .send({ reason: 'Disbursement already settled' })
        .expect(409);
      expect(outflows.handleFailure).not.toHaveBeenCalled();
    });

    it('returns 404 when the disbursement does not exist', async () => {
      authenticate_ops();
      disbursements.findById.mockResolvedValue(null);
      await request(app.getHttpServer())
        .post(`/ops/disbursements/${DISBURSEMENT_ID}/abandon-attempt`)
        .set('Cookie', [`ops_session=${OPS_TOKEN}`])
        .send({ reason: 'Does not exist' })
        .expect(404);
      expect(outflows.handleFailure).not.toHaveBeenCalled();
    });

    it('rejects an empty reason with 400', async () => {
      authenticate_ops();
      await request(app.getHttpServer())
        .post(`/ops/disbursements/${DISBURSEMENT_ID}/abandon-attempt`)
        .set('Cookie', [`ops_session=${OPS_TOKEN}`])
        .send({ reason: 'x' })
        .expect(400);
      expect(outflows.handleFailure).not.toHaveBeenCalled();
    });

    it('401 with no ops_session cookie', async () => {
      await request(app.getHttpServer())
        .post(`/ops/disbursements/${DISBURSEMENT_ID}/abandon-attempt`)
        .send({ reason: 'Not authenticated' })
        .expect(401);
      expect(outflows.handleFailure).not.toHaveBeenCalled();
    });
  });

  // ── POST /recreate-for-loan/:loan_id — fresh disbursement on a stranded loan ─

  describe('POST /recreate-for-loan/:loan_id', () => {
    const LOAN_ID    = '33333333-3333-3333-3333-333333333333';
    const NEW_DISB_ID = '44444444-4444-4444-4444-444444444444';

    function active_loan_with_account(overrides: Record<string, unknown> = {}) {
      return {
        id: LOAN_ID,
        user_id: 'user-001',
        status: 'ACTIVE',
        principal_ngn: { toString: () => '300000' },
        disbursement_account: {
          id: 'acct-001',
          provider_name: 'GTBank',
          provider_code: '058',
          account_unique: '0123456789',
          account_holder_name: 'Ada Obi',
        },
        ...overrides,
      };
    }

    it('writes audit row with target=loan, then creates a fresh disbursement and dispatches it', async () => {
      authenticate_ops();
      const tx = make_tx();
      prisma.loan.findUnique.mockResolvedValue(active_loan_with_account());
      prisma.disbursement.findFirst.mockResolvedValue(null); // no blocking row
      prisma.$transaction.mockImplementation(async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
        return fn(tx as unknown as Prisma.TransactionClient);
      });
      disbursements.createForLoan.mockResolvedValue({ id: NEW_DISB_ID });
      outflows.dispatch.mockResolvedValue(undefined);

      const res = await request(app.getHttpServer())
        .post(`/ops/disbursements/recreate-for-loan/${LOAN_ID}`)
        .set('Cookie', [`ops_session=${OPS_TOKEN}`])
        .set('x-request-id', 'req_recreate_001')
        .expect(202);

      expect(res.body).toMatchObject({ disbursement_id: NEW_DISB_ID });

      expect(tx.opsAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          ops_user_id: OPS_USER_ID,
          action:      OPS_ACTION.DISBURSEMENT_RECREATE,
          target_type: OPS_TARGET_TYPE.LOAN,
          target_id:   LOAN_ID,
          request_id:  'req_recreate_001',
        }),
      });

      // Snapshot uses the loan's CURRENT default account, including provider_code.
      expect(disbursements.createForLoan).toHaveBeenCalledWith(
        expect.objectContaining({
          source_id:      LOAN_ID,
          provider_name:  'GTBank',
          provider_code:  '058',
          account_unique: '0123456789',
          account_name:   'Ada Obi',
        }),
      );
      expect(outflows.dispatch).toHaveBeenCalledWith(NEW_DISB_ID);
    });

    it('returns 404 when the loan does not exist', async () => {
      authenticate_ops();
      prisma.loan.findUnique.mockResolvedValue(null);

      await request(app.getHttpServer())
        .post(`/ops/disbursements/recreate-for-loan/${LOAN_ID}`)
        .set('Cookie', [`ops_session=${OPS_TOKEN}`])
        .expect(404);

      expect(disbursements.createForLoan).not.toHaveBeenCalled();
      expect(outflows.dispatch).not.toHaveBeenCalled();
    });

    it('returns 409 when the loan is not ACTIVE', async () => {
      authenticate_ops();
      prisma.loan.findUnique.mockResolvedValue(active_loan_with_account({ status: 'REPAID' }));

      const res = await request(app.getHttpServer())
        .post(`/ops/disbursements/recreate-for-loan/${LOAN_ID}`)
        .set('Cookie', [`ops_session=${OPS_TOKEN}`])
        .expect(409);

      expect(res.body.error.code).toBe('LOAN_NOT_ACTIVE_FOR_DISBURSEMENT');
      expect(disbursements.createForLoan).not.toHaveBeenCalled();
    });

    it('returns 409 when the loan already has a non-terminal disbursement', async () => {
      authenticate_ops();
      prisma.loan.findUnique.mockResolvedValue(active_loan_with_account());
      prisma.disbursement.findFirst.mockResolvedValue({
        id: 'existing-disb',
        status: 'ON_HOLD',
      });

      const res = await request(app.getHttpServer())
        .post(`/ops/disbursements/recreate-for-loan/${LOAN_ID}`)
        .set('Cookie', [`ops_session=${OPS_TOKEN}`])
        .expect(409);

      expect(res.body.error.code).toBe('LOAN_HAS_ACTIVE_DISBURSEMENT');
      expect(disbursements.createForLoan).not.toHaveBeenCalled();
    });

    it('returns 422 when the loan has no disbursement_account (or missing provider_code)', async () => {
      authenticate_ops();
      prisma.loan.findUnique.mockResolvedValue(active_loan_with_account({
        disbursement_account: null,
      }));
      prisma.disbursement.findFirst.mockResolvedValue(null);

      await request(app.getHttpServer())
        .post(`/ops/disbursements/recreate-for-loan/${LOAN_ID}`)
        .set('Cookie', [`ops_session=${OPS_TOKEN}`])
        .expect(422);

      expect(disbursements.createForLoan).not.toHaveBeenCalled();
    });

    it('rejects a non-UUID loan_id with 400', async () => {
      authenticate_ops();
      await request(app.getHttpServer())
        .post(`/ops/disbursements/recreate-for-loan/not-a-uuid`)
        .set('Cookie', [`ops_session=${OPS_TOKEN}`])
        .expect(400);
      expect(prisma.loan.findUnique).not.toHaveBeenCalled();
    });

    it('401 with no ops_session cookie', async () => {
      await request(app.getHttpServer())
        .post(`/ops/disbursements/recreate-for-loan/${LOAN_ID}`)
        .expect(401);
      expect(prisma.loan.findUnique).not.toHaveBeenCalled();
    });
  });
});
