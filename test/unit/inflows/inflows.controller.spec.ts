import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { mock, MockProxy } from 'jest-mock-extended';
import { LoanStatus } from '@prisma/client';
import { InflowsController } from '@/modules/inflows/inflows.controller';
import { LoansService } from '@/modules/loans/loans.service';
import { GlobalExceptionFilter } from '@/common/filters/global-exception.filter';
import { SessionGuard } from '@/common/guards/session.guard';
import { CurrentUser } from '@/common/decorators/current-user.decorator';

const USER_ID   = 'user-uuid-001';
const INFLOW_ID = '11111111-1111-4111-8111-111111111111';  // valid UUID v4
const LOAN_ID   = '22222222-2222-4222-8222-222222222222';  // valid UUID v4

// SessionGuard normally hits Redis + DB; bypass it for the controller-shape test
// and pin CurrentUser on the request object.
class StubSessionGuard {
  canActivate(ctx: { switchToHttp: () => { getRequest: () => { user: unknown } } }): boolean {
    ctx.switchToHttp().getRequest().user = { id: USER_ID, email: 'a@b.com' };
    return true;
  }
}

describe('InflowsController', () => {
  let app: INestApplication;
  let loans: MockProxy<LoansService>;

  beforeEach(async () => {
    loans = mock<LoansService>();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [InflowsController],
      providers: [
        { provide: LoansService, useValue: loans },
      ],
    })
      .overrideGuard(SessionGuard)
      .useClass(StubSessionGuard)
      .compile();

    app = module.createNestApplication();
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterEach(() => app.close());

  // ── GET /v1/inflows/unmatched ───────────────────────────────────────────────

  it('returns the user\'s unmatched inflows wrapped in { items }', async () => {
    loans.listUnmatchedInflowsForUser.mockResolvedValue([
      {
        id:              INFLOW_ID,
        amount_ngn:      '10130.00',
        received_at:     new Date('2026-04-30T12:00:07Z'),
        payer_name:      'JEREMIAH SUCCEED IKWUJE',
        payer_bank_name: 'OPay',
        received_via:    '9931107760',
        status:          'CLAIMABLE',
      },
    ]);

    const res = await request(app.getHttpServer())
      .get('/inflows/unmatched')
      .expect(200);

    expect(loans.listUnmatchedInflowsForUser).toHaveBeenCalledWith(USER_ID);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      id:     INFLOW_ID,
      status: 'CLAIMABLE',
    });
  });

  it('returns empty items array when user has none', async () => {
    loans.listUnmatchedInflowsForUser.mockResolvedValue([]);

    const res = await request(app.getHttpServer())
      .get('/inflows/unmatched')
      .expect(200);

    expect(res.body).toEqual({ items: [] });
  });

  // ── POST /v1/inflows/:inflow_id/apply ───────────────────────────────────────

  it('applies the inflow to the chosen loan', async () => {
    loans.applyInflowToLoan.mockResolvedValue({
      loan_id:              LOAN_ID,
      new_status:           LoanStatus.ACTIVE,
      applied_to_custody:   '0.00',
      applied_to_interest:  '0.00',
      applied_to_principal: '10130.00',
      overpay_ngn:          '0.00',
      outstanding_ngn:      '489870.00',
    });

    const res = await request(app.getHttpServer())
      .post(`/inflows/${INFLOW_ID}/apply`)
      .send({ loan_id: LOAN_ID })
      .expect(200);

    expect(loans.applyInflowToLoan).toHaveBeenCalledWith(USER_ID, INFLOW_ID, LOAN_ID);
    expect(res.body.loan_id).toBe(LOAN_ID);
    expect(res.body.applied_to_principal).toBe('10130.00');
  });

  it('rejects malformed loan_id with 400', async () => {
    await request(app.getHttpServer())
      .post(`/inflows/${INFLOW_ID}/apply`)
      .send({ loan_id: 'not-a-uuid' })
      .expect(400);
    expect(loans.applyInflowToLoan).not.toHaveBeenCalled();
  });

  it('rejects malformed inflow_id (non-UUID path param) with 400', async () => {
    await request(app.getHttpServer())
      .post('/inflows/not-a-uuid/apply')
      .send({ loan_id: LOAN_ID })
      .expect(400);
    expect(loans.applyInflowToLoan).not.toHaveBeenCalled();
  });
});
