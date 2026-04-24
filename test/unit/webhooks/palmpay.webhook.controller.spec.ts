import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { mock, MockProxy } from 'jest-mock-extended';
import { LoanStatus, OutflowStatus } from '@prisma/client';
import { PalmpayWebhookController } from '@/modules/webhooks/palmpay.webhook.controller';
import { PalmpayProvider } from '@/providers/palmpay/palmpay.provider';
import { OutflowsService } from '@/modules/disbursements/outflows.service';
import { LoansService } from '@/modules/loans/loans.service';
import { OpsAlertsService } from '@/modules/ops-alerts/ops-alerts.service';
import { PrismaService } from '@/database/prisma.service';
import { GlobalExceptionFilter } from '@/common/filters/global-exception.filter';

const DISB_ID      = 'disb-uuid-001';
const OUTFLOW_ID   = 'outflow-uuid-001';
const PROVIDER_REF = `${DISB_ID}:outflow:1`;

const USER_ID  = 'user-uuid-001';
const LOAN_ID  = 'loan-uuid-001';
const VA_NO    = '9012345678';
const ORDER_NO = 'palmpay_collect_001';

const PAYOUT_NOTIFICATION: Record<string, unknown> = {
  orderId:      PROVIDER_REF,
  orderNo:      'palmpay_internal_001',
  appId:        'AppId123456',
  currency:     'NGN',
  amount:       300000,
  orderStatus:  2,
  sessionId:    '100033240509135230000500932911',
  completeTime: 1658574095184,
  sign:         'valid_sig',
};

// Collection notification: orderAmount in CENTS. 5,000,000 cents = N50,000 (above floor).
const COLLECTION_NOTIFICATION: Record<string, unknown> = {
  orderNo:           ORDER_NO,
  orderStatus:       2,
  createdTime:       1658574000000,
  updateTime:        1658574095000,
  currency:          'NGN',
  orderAmount:       5_000_000,
  payerAccountNo:    '0123456789',
  payerAccountName:  'Ada Obi',
  payerBankName:     'GTBank',
  virtualAccountNo:  VA_NO,
  sign:              'valid_sig',
};

const OUTFLOW_ROW = {
  id:                 OUTFLOW_ID,
  disbursement_id:    DISB_ID,
  provider_reference: PROVIDER_REF,
  status:             OutflowStatus.PROCESSING,
};

const ACTIVE_LOAN = { id: LOAN_ID };

function makePrisma() {
  return {
    outflow:               { findUnique: jest.fn().mockResolvedValue(OUTFLOW_ROW) },
    userRepaymentAccount:  { findUnique: jest.fn().mockResolvedValue(null) },
    loan:                  { findMany: jest.fn().mockResolvedValue([]) },
    inflow:                { upsert: jest.fn().mockResolvedValue({ id: 'inflow-uuid-001', is_matched: false }) },
  };
}

describe('PalmpayWebhookController', () => {
  let app: INestApplication;
  let provider:   MockProxy<PalmpayProvider>;
  let outflows:   MockProxy<OutflowsService>;
  let loans:      MockProxy<LoansService>;
  let ops_alerts: MockProxy<OpsAlertsService>;
  let prisma:     ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma     = makePrisma();
    provider   = mock<PalmpayProvider>();
    outflows   = mock<OutflowsService>();
    loans      = mock<LoansService>();
    ops_alerts = mock<OpsAlertsService>();

    provider.verifyWebhookSignature.mockReturnValue(true);
    provider.getTransferStatus.mockResolvedValue({ status: 'successful' });
    ops_alerts.alertUnmatchedInflow.mockResolvedValue();
    loans.creditInflow.mockResolvedValue({
      loan_id:              LOAN_ID,
      new_status:           LoanStatus.ACTIVE,
      applied_to_custody:   '0.00',
      applied_to_interest:  '0.00',
      applied_to_principal: '50000.00',
      overpay_ngn:          '0.00',
      outstanding_ngn:      '450000.00',
    });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PalmpayWebhookController],
      providers: [
        { provide: PalmpayProvider,   useValue: provider },
        { provide: OutflowsService,   useValue: outflows },
        { provide: LoansService,      useValue: loans },
        { provide: OpsAlertsService,  useValue: ops_alerts },
        { provide: PrismaService,     useValue: prisma },
      ],
    }).compile();

    app = module.createNestApplication({ rawBody: true });
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
  });

  afterEach(() => app.close());

  // ── signature verification ──────────────────────────────────────────────────

  it('returns 401 when signature is invalid', async () => {
    provider.verifyWebhookSignature.mockReturnValue(false);

    await request(app.getHttpServer())
      .post('/webhooks/palmpay')
      .send(PAYOUT_NOTIFICATION)
      .expect(401);

    expect(outflows.handleSuccess).not.toHaveBeenCalled();
  });

  it('verifies signature on raw body before any parsing', async () => {
    provider.verifyWebhookSignature.mockReturnValue(false);

    await request(app.getHttpServer())
      .post('/webhooks/palmpay')
      .send(PAYOUT_NOTIFICATION)
      .expect(401);

    expect(provider.verifyWebhookSignature).toHaveBeenCalledWith(expect.any(String), '');
  });

  // ── response format ─────────────────────────────────────────────────────────

  it('responds with plain text "success" as required by PalmPay', async () => {
    const res = await request(app.getHttpServer())
      .post('/webhooks/palmpay')
      .send(PAYOUT_NOTIFICATION)
      .expect(200);

    expect(res.text).toBe('success');
  });

  // ── payout notification (status verification) ───────────────────────────────

  it('queries PalmPay transfer status before acting on payout webhook', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/palmpay')
      .send(PAYOUT_NOTIFICATION)
      .expect(200);

    expect(provider.getTransferStatus).toHaveBeenCalledWith(PROVIDER_REF);
  });

  it('calls handleSuccess when status query returns "successful"', async () => {
    provider.getTransferStatus.mockResolvedValue({ status: 'successful' });

    await request(app.getHttpServer())
      .post('/webhooks/palmpay')
      .send(PAYOUT_NOTIFICATION)
      .expect(200);

    expect(outflows.handleSuccess).toHaveBeenCalledWith(
      OUTFLOW_ID, DISB_ID, expect.any(String), expect.any(Object),
    );
  });

  it('calls handleFailure when status query returns "failed", using queried failure_reason', async () => {
    provider.getTransferStatus.mockResolvedValue({
      status: 'failed',
      failure_reason: 'Account not found',
      failure_code: 'ERR_001',
    });

    await request(app.getHttpServer())
      .post('/webhooks/palmpay')
      .send(PAYOUT_NOTIFICATION)
      .expect(200);

    expect(outflows.handleFailure).toHaveBeenCalledWith(
      OUTFLOW_ID, DISB_ID, 'Account not found', 'ERR_001',
    );
  });

  it('defers processing when status query returns "processing" (webhook was premature)', async () => {
    provider.getTransferStatus.mockResolvedValue({ status: 'processing' });

    await request(app.getHttpServer())
      .post('/webhooks/palmpay')
      .send(PAYOUT_NOTIFICATION)
      .expect(200);

    expect(outflows.handleSuccess).not.toHaveBeenCalled();
    expect(outflows.handleFailure).not.toHaveBeenCalled();
  });

  it('defers processing when status query throws (network error) — PalmPay will retry', async () => {
    provider.getTransferStatus.mockRejectedValue(new Error('PalmPay API timeout'));

    await request(app.getHttpServer())
      .post('/webhooks/palmpay')
      .send(PAYOUT_NOTIFICATION)
      .expect(200);

    expect(outflows.handleSuccess).not.toHaveBeenCalled();
    expect(outflows.handleFailure).not.toHaveBeenCalled();
  });

  // ── payout idempotency ─────────────────────────────────────────────────────

  it('skips status query when Outflow is already SUCCESSFUL', async () => {
    prisma.outflow.findUnique.mockResolvedValue({ ...OUTFLOW_ROW, status: OutflowStatus.SUCCESSFUL });

    await request(app.getHttpServer())
      .post('/webhooks/palmpay')
      .send(PAYOUT_NOTIFICATION)
      .expect(200);

    expect(provider.getTransferStatus).not.toHaveBeenCalled();
    expect(outflows.handleSuccess).not.toHaveBeenCalled();
  });

  it('skips status query when Outflow is already FAILED', async () => {
    prisma.outflow.findUnique.mockResolvedValue({ ...OUTFLOW_ROW, status: OutflowStatus.FAILED });

    await request(app.getHttpServer())
      .post('/webhooks/palmpay')
      .send(PAYOUT_NOTIFICATION)
      .expect(200);

    expect(provider.getTransferStatus).not.toHaveBeenCalled();
    expect(outflows.handleFailure).not.toHaveBeenCalled();
  });

  it('returns success when outflow not found (unknown reference)', async () => {
    prisma.outflow.findUnique.mockResolvedValue(null);

    await request(app.getHttpServer())
      .post('/webhooks/palmpay')
      .send(PAYOUT_NOTIFICATION)
      .expect(200);

    expect(provider.getTransferStatus).not.toHaveBeenCalled();
  });

  // ── collection notifications — v1.1 matching flow ──────────────────────────

  describe('collection notifications', () => {
    it('does not query transfer status for collection notifications', async () => {
      await request(app.getHttpServer())
        .post('/webhooks/palmpay')
        .send(COLLECTION_NOTIFICATION)
        .expect(200);

      expect(provider.getTransferStatus).not.toHaveBeenCalled();
      expect(outflows.handleSuccess).not.toHaveBeenCalled();
    });

    it('skips non-SUCCESS status (orderStatus != 2) without writing an Inflow', async () => {
      await request(app.getHttpServer())
        .post('/webhooks/palmpay')
        .send({ ...COLLECTION_NOTIFICATION, orderStatus: 1 })
        .expect(200);

      expect(prisma.userRepaymentAccount.findUnique).not.toHaveBeenCalled();
      expect(loans.creditInflow).not.toHaveBeenCalled();
    });

    it('writes unmatched inflow with reason "no_user_for_va" when VA is unknown', async () => {
      prisma.userRepaymentAccount.findUnique.mockResolvedValue(null);

      await request(app.getHttpServer())
        .post('/webhooks/palmpay')
        .send(COLLECTION_NOTIFICATION)
        .expect(200);

      expect(prisma.inflow.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            is_matched:        false,
            user_id:           null,
            provider_response: expect.objectContaining({ bitmonie_unmatched_reason: 'no_user_for_va' }),
          }),
        }),
      );
      expect(loans.creditInflow).not.toHaveBeenCalled();
    });

    it('writes unmatched inflow with reason "below_floor" when amount is below N10,000', async () => {
      prisma.userRepaymentAccount.findUnique.mockResolvedValue({ user_id: USER_ID } as never);

      // 500,000 cents = N5,000 — below the N10,000 floor.
      await request(app.getHttpServer())
        .post('/webhooks/palmpay')
        .send({ ...COLLECTION_NOTIFICATION, orderAmount: 500_000 })
        .expect(200);

      expect(prisma.inflow.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            user_id:           USER_ID,
            provider_response: expect.objectContaining({ bitmonie_unmatched_reason: 'below_floor' }),
          }),
        }),
      );
      expect(loans.creditInflow).not.toHaveBeenCalled();
    });

    it('writes unmatched inflow with reason "no_active_loans" when user has no ACTIVE loans', async () => {
      prisma.userRepaymentAccount.findUnique.mockResolvedValue({ user_id: USER_ID } as never);
      prisma.loan.findMany.mockResolvedValue([]);

      await request(app.getHttpServer())
        .post('/webhooks/palmpay')
        .send(COLLECTION_NOTIFICATION)
        .expect(200);

      expect(prisma.inflow.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            provider_response: expect.objectContaining({ bitmonie_unmatched_reason: 'no_active_loans' }),
          }),
        }),
      );
      expect(loans.creditInflow).not.toHaveBeenCalled();
    });

    it('writes unmatched inflow with reason "multiple_active_loans" when user has 2+ ACTIVE loans', async () => {
      prisma.userRepaymentAccount.findUnique.mockResolvedValue({ user_id: USER_ID } as never);
      prisma.loan.findMany.mockResolvedValue([{ id: LOAN_ID }, { id: 'loan-uuid-002' }] as never);

      await request(app.getHttpServer())
        .post('/webhooks/palmpay')
        .send(COLLECTION_NOTIFICATION)
        .expect(200);

      expect(prisma.inflow.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            provider_response: expect.objectContaining({ bitmonie_unmatched_reason: 'multiple_active_loans' }),
          }),
        }),
      );
      expect(loans.creditInflow).not.toHaveBeenCalled();
    });

    it('auto-credits via creditInflow with AUTO_AMOUNT when user has exactly one ACTIVE loan', async () => {
      prisma.userRepaymentAccount.findUnique.mockResolvedValue({ user_id: USER_ID } as never);
      prisma.loan.findMany.mockResolvedValue([ACTIVE_LOAN] as never);
      prisma.inflow.upsert.mockResolvedValue({ id: 'inflow-uuid-001', is_matched: false } as never);

      await request(app.getHttpServer())
        .post('/webhooks/palmpay')
        .send(COLLECTION_NOTIFICATION)
        .expect(200);

      expect(loans.creditInflow).toHaveBeenCalledWith(
        expect.objectContaining({
          inflow_id:    'inflow-uuid-001',
          loan_id:      LOAN_ID,
          match_method: 'AUTO_AMOUNT',
        }),
      );
    });

    it('skips creditInflow on duplicate webhook (Inflow already matched)', async () => {
      prisma.userRepaymentAccount.findUnique.mockResolvedValue({ user_id: USER_ID } as never);
      prisma.loan.findMany.mockResolvedValue([ACTIVE_LOAN] as never);
      prisma.inflow.upsert.mockResolvedValue({ id: 'inflow-uuid-001', is_matched: true } as never);

      await request(app.getHttpServer())
        .post('/webhooks/palmpay')
        .send(COLLECTION_NOTIFICATION)
        .expect(200);

      expect(loans.creditInflow).not.toHaveBeenCalled();
    });

    it('still ACKs and leaves Inflow unmatched when creditInflow throws', async () => {
      prisma.userRepaymentAccount.findUnique.mockResolvedValue({ user_id: USER_ID } as never);
      prisma.loan.findMany.mockResolvedValue([ACTIVE_LOAN] as never);
      prisma.inflow.upsert.mockResolvedValue({ id: 'inflow-uuid-001', is_matched: false } as never);
      loans.creditInflow.mockRejectedValue(new Error('DB locked'));

      const res = await request(app.getHttpServer())
        .post('/webhooks/palmpay')
        .send(COLLECTION_NOTIFICATION)
        .expect(200);

      expect(res.text).toBe('success');
    });

    // ── ops alerts ──────────────────────────────────────────────────────────

    it('pages ops via OpsAlertsService when an inflow is unmatched (e.g. no user for VA)', async () => {
      prisma.userRepaymentAccount.findUnique.mockResolvedValue(null);

      await request(app.getHttpServer())
        .post('/webhooks/palmpay')
        .send(COLLECTION_NOTIFICATION)
        .expect(200);

      expect(ops_alerts.alertUnmatchedInflow).toHaveBeenCalledWith(
        expect.objectContaining({
          reason:          'no_user_for_va',
          provider:        'palmpay',
          order_no:        ORDER_NO,
          amount_ngn:      '50000.00',
          user_id:         null,
          virtual_account: VA_NO,
          payer_name:      'Ada Obi',
          payer_account:   '0123456789',
        }),
      );
    });

    it('pages ops with reason="credit_failed" when creditInflow throws', async () => {
      prisma.userRepaymentAccount.findUnique.mockResolvedValue({ user_id: USER_ID } as never);
      prisma.loan.findMany.mockResolvedValue([ACTIVE_LOAN] as never);
      prisma.inflow.upsert.mockResolvedValue({ id: 'inflow-uuid-001', is_matched: false } as never);
      loans.creditInflow.mockRejectedValue(new Error('DB locked'));

      await request(app.getHttpServer())
        .post('/webhooks/palmpay')
        .send(COLLECTION_NOTIFICATION)
        .expect(200);

      expect(ops_alerts.alertUnmatchedInflow).toHaveBeenCalledWith(
        expect.objectContaining({
          reason:  'credit_failed',
          loan_id: LOAN_ID,
          detail:  'DB locked',
        }),
      );
    });

    it('does not page ops on the auto-match happy path', async () => {
      prisma.userRepaymentAccount.findUnique.mockResolvedValue({ user_id: USER_ID } as never);
      prisma.loan.findMany.mockResolvedValue([ACTIVE_LOAN] as never);
      prisma.inflow.upsert.mockResolvedValue({ id: 'inflow-uuid-001', is_matched: false } as never);

      await request(app.getHttpServer())
        .post('/webhooks/palmpay')
        .send(COLLECTION_NOTIFICATION)
        .expect(200);

      expect(ops_alerts.alertUnmatchedInflow).not.toHaveBeenCalled();
    });
  });
});
