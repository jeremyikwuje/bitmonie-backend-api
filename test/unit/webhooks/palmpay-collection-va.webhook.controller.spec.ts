import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { mock, MockProxy } from 'jest-mock-extended';
import { LoanStatus } from '@prisma/client';
import { PalmpayCollectionVaWebhookController } from '@/modules/webhooks/palmpay-collection-va.webhook.controller';
import { PalmpayProvider } from '@/providers/palmpay/palmpay.provider';
import { LoansService } from '@/modules/loans/loans.service';
import { OpsAlertsService } from '@/modules/ops-alerts/ops-alerts.service';
import { WebhooksLogService } from '@/modules/webhooks-log/webhooks-log.service';
import { PrismaService } from '@/database/prisma.service';
import { GlobalExceptionFilter } from '@/common/filters/global-exception.filter';

const USER_ID  = 'user-uuid-001';
const LOAN_ID  = 'loan-uuid-001';
const VA_NO    = '9012345678';
const ORDER_NO = 'palmpay_collect_001';

// Collection notification: orderAmount in CENTS. 5,000,000 cents = N50,000
// (above floor). orderStatus=1 means SUCCESS on the collection scheme — this
// is the divergence from payout (where 2 = success). Real-world payload from
// the production drop is the source of truth here.
const COLLECTION_NOTIFICATION: Record<string, unknown> = {
  orderNo:           ORDER_NO,
  orderStatus:       1,
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

const REQUERY_OK = {
  status:             'successful' as const,
  amount_kobo:        5_000_000,
  currency:           'NGN',
  virtual_account_no: VA_NO,
  payer_account_name: 'Ada Obi',
};

const ACTIVE_LOAN = { id: LOAN_ID };

function makePrisma() {
  return {
    userRepaymentAccount: { findUnique: jest.fn().mockResolvedValue(null) },
    loan:                 { findMany:   jest.fn().mockResolvedValue([]) },
    inflow:               { upsert:     jest.fn().mockResolvedValue({ id: 'inflow-uuid-001', is_matched: false }) },
  };
}

describe('PalmpayCollectionVaWebhookController', () => {
  let app: INestApplication;
  let provider:     MockProxy<PalmpayProvider>;
  let loans:        MockProxy<LoansService>;
  let ops_alerts:   MockProxy<OpsAlertsService>;
  let webhooks_log: MockProxy<WebhooksLogService>;
  let prisma:       ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma       = makePrisma();
    provider     = mock<PalmpayProvider>();
    loans        = mock<LoansService>();
    ops_alerts   = mock<OpsAlertsService>();
    webhooks_log = mock<WebhooksLogService>();
    webhooks_log.record.mockResolvedValue('webhook-log-id');
    webhooks_log.updateOutcome.mockResolvedValue();

    provider.verifyWebhookSignature.mockReturnValue(true);
    provider.getCollectionOrderStatus.mockResolvedValue(REQUERY_OK);
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
      controllers: [PalmpayCollectionVaWebhookController],
      providers: [
        { provide: PalmpayProvider,    useValue: provider },
        { provide: LoansService,       useValue: loans },
        { provide: OpsAlertsService,   useValue: ops_alerts },
        { provide: PrismaService,      useValue: prisma },
        { provide: WebhooksLogService, useValue: webhooks_log },
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
      .post('/webhooks/palmpay/collection/va')
      .send(COLLECTION_NOTIFICATION)
      .expect(401);

    expect(loans.creditInflow).not.toHaveBeenCalled();
  });

  it('responds with plain text "success" as required by PalmPay', async () => {
    prisma.userRepaymentAccount.findUnique.mockResolvedValue({ user_id: USER_ID } as never);
    prisma.loan.findMany.mockResolvedValue([ACTIVE_LOAN] as never);

    const res = await request(app.getHttpServer())
      .post('/webhooks/palmpay/collection/va')
      .send(COLLECTION_NOTIFICATION)
      .expect(200);

    expect(res.text).toBe('success');
  });

  // ── orderStatus semantics — the bug this PR fixes ──────────────────────────

  it('treats orderStatus=1 as SUCCESS on the collection scheme (regression)', async () => {
    prisma.userRepaymentAccount.findUnique.mockResolvedValue({ user_id: USER_ID } as never);
    prisma.loan.findMany.mockResolvedValue([ACTIVE_LOAN] as never);

    await request(app.getHttpServer())
      .post('/webhooks/palmpay/collection/va')
      .send(COLLECTION_NOTIFICATION) // orderStatus=1
      .expect(200);

    expect(loans.creditInflow).toHaveBeenCalledWith(
      expect.objectContaining({ loan_id: LOAN_ID, match_method: 'AUTO_AMOUNT' }),
    );
  });

  it('does NOT credit when orderStatus=2 (collection FAILED)', async () => {
    prisma.userRepaymentAccount.findUnique.mockResolvedValue({ user_id: USER_ID } as never);
    prisma.loan.findMany.mockResolvedValue([ACTIVE_LOAN] as never);

    await request(app.getHttpServer())
      .post('/webhooks/palmpay/collection/va')
      .send({ ...COLLECTION_NOTIFICATION, orderStatus: 2 })
      .expect(200);

    expect(prisma.userRepaymentAccount.findUnique).not.toHaveBeenCalled();
    expect(loans.creditInflow).not.toHaveBeenCalled();
  });

  // ── independent verification (defence-in-depth) ─────────────────────────────

  it('re-queries PalmPay before crediting, even on a valid-signed webhook', async () => {
    prisma.userRepaymentAccount.findUnique.mockResolvedValue({ user_id: USER_ID } as never);
    prisma.loan.findMany.mockResolvedValue([ACTIVE_LOAN] as never);

    await request(app.getHttpServer())
      .post('/webhooks/palmpay/collection/va')
      .send(COLLECTION_NOTIFICATION)
      .expect(200);

    expect(provider.getCollectionOrderStatus).toHaveBeenCalledWith(ORDER_NO);
    // Re-query must run BEFORE creditInflow.
    const requery_call = provider.getCollectionOrderStatus.mock.invocationCallOrder[0]!;
    const credit_call  = loans.creditInflow.mock.invocationCallOrder[0]!;
    expect(requery_call).toBeLessThan(credit_call);
  });

  it('defers when re-query throws (transient PalmPay outage)', async () => {
    prisma.userRepaymentAccount.findUnique.mockResolvedValue({ user_id: USER_ID } as never);
    prisma.loan.findMany.mockResolvedValue([ACTIVE_LOAN] as never);
    provider.getCollectionOrderStatus.mockRejectedValue(new Error('PalmPay timeout'));

    await request(app.getHttpServer())
      .post('/webhooks/palmpay/collection/va')
      .send(COLLECTION_NOTIFICATION)
      .expect(200);

    expect(loans.creditInflow).not.toHaveBeenCalled();
    expect(prisma.inflow.upsert).not.toHaveBeenCalled(); // no row written; PalmPay will retry
  });

  it('defers when re-query returns status="unknown"', async () => {
    prisma.userRepaymentAccount.findUnique.mockResolvedValue({ user_id: USER_ID } as never);
    prisma.loan.findMany.mockResolvedValue([ACTIVE_LOAN] as never);
    provider.getCollectionOrderStatus.mockResolvedValue({ status: 'unknown' });

    await request(app.getHttpServer())
      .post('/webhooks/palmpay/collection/va')
      .send(COLLECTION_NOTIFICATION)
      .expect(200);

    expect(loans.creditInflow).not.toHaveBeenCalled();
  });

  it('refuses to credit when re-query amount disagrees with webhook', async () => {
    prisma.userRepaymentAccount.findUnique.mockResolvedValue({ user_id: USER_ID } as never);
    prisma.loan.findMany.mockResolvedValue([ACTIVE_LOAN] as never);
    provider.getCollectionOrderStatus.mockResolvedValue({ ...REQUERY_OK, amount_kobo: 4_000_000 });

    await request(app.getHttpServer())
      .post('/webhooks/palmpay/collection/va')
      .send(COLLECTION_NOTIFICATION)
      .expect(200);

    expect(loans.creditInflow).not.toHaveBeenCalled();
    expect(ops_alerts.alertUnmatchedInflow).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'requery_mismatch' }),
    );
  });

  it('refuses to credit when re-query VA disagrees with webhook', async () => {
    prisma.userRepaymentAccount.findUnique.mockResolvedValue({ user_id: USER_ID } as never);
    prisma.loan.findMany.mockResolvedValue([ACTIVE_LOAN] as never);
    provider.getCollectionOrderStatus.mockResolvedValue({ ...REQUERY_OK, virtual_account_no: 'OTHER_VA' });

    await request(app.getHttpServer())
      .post('/webhooks/palmpay/collection/va')
      .send(COLLECTION_NOTIFICATION)
      .expect(200);

    expect(loans.creditInflow).not.toHaveBeenCalled();
    expect(ops_alerts.alertUnmatchedInflow).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'requery_mismatch' }),
    );
  });

  it('treats re-query status="failed" as untrusted — no credit, ops paged', async () => {
    prisma.userRepaymentAccount.findUnique.mockResolvedValue({ user_id: USER_ID } as never);
    prisma.loan.findMany.mockResolvedValue([ACTIVE_LOAN] as never);
    provider.getCollectionOrderStatus.mockResolvedValue({ status: 'failed', failure_reason: 'Reversed' });

    await request(app.getHttpServer())
      .post('/webhooks/palmpay/collection/va')
      .send(COLLECTION_NOTIFICATION)
      .expect(200);

    expect(loans.creditInflow).not.toHaveBeenCalled();
    expect(ops_alerts.alertUnmatchedInflow).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'requery_mismatch' }),
    );
  });

  // ── matching flow ──────────────────────────────────────────────────────────

  it('writes unmatched inflow with reason "no_user_for_va" when VA is unknown', async () => {
    prisma.userRepaymentAccount.findUnique.mockResolvedValue(null);

    await request(app.getHttpServer())
      .post('/webhooks/palmpay/collection/va')
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
    expect(provider.getCollectionOrderStatus).not.toHaveBeenCalled(); // gated before re-query
  });

  it('writes unmatched inflow with reason "below_floor" when amount is below N10,000 and does not close any loan', async () => {
    prisma.userRepaymentAccount.findUnique.mockResolvedValue({ user_id: USER_ID } as never);
    loans.amountClosesAnyActiveLoan.mockResolvedValue(false);

    // 500,000 cents = N5,000 — below the N10,000 floor.
    await request(app.getHttpServer())
      .post('/webhooks/palmpay/collection/va')
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

  it('bypasses the floor and auto-credits when a sub-N10,000 amount closes an ACTIVE loan', async () => {
    prisma.userRepaymentAccount.findUnique.mockResolvedValue({ user_id: USER_ID } as never);
    prisma.loan.findMany.mockResolvedValue([ACTIVE_LOAN] as never);
    prisma.inflow.upsert.mockResolvedValue({ id: 'inflow-uuid-001', is_matched: false } as never);
    // Customer is paying off a loan whose outstanding has accrued down to N8,390.
    loans.amountClosesAnyActiveLoan.mockResolvedValue(true);
    provider.getCollectionOrderStatus.mockResolvedValue({ ...REQUERY_OK, amount_kobo: 839_000 });

    await request(app.getHttpServer())
      .post('/webhooks/palmpay/collection/va')
      .send({ ...COLLECTION_NOTIFICATION, orderAmount: 839_000 })
      .expect(200);

    expect(loans.amountClosesAnyActiveLoan).toHaveBeenCalledWith(USER_ID, expect.anything());
    expect(loans.creditInflow).toHaveBeenCalledWith(
      expect.objectContaining({ loan_id: LOAN_ID, match_method: 'AUTO_AMOUNT' }),
    );
    // Did NOT persist as unmatched (no below_floor row).
    const upsert_calls = prisma.inflow.upsert.mock.calls as unknown as Array<[{ create: { is_matched: boolean; provider_response?: Record<string, unknown> } }]>;
    expect(upsert_calls.every((c) => !('bitmonie_unmatched_reason' in (c[0].create.provider_response ?? {})))).toBe(true);
  });

  it('writes unmatched inflow with reason "no_active_loans" when user has no ACTIVE loans', async () => {
    prisma.userRepaymentAccount.findUnique.mockResolvedValue({ user_id: USER_ID } as never);
    prisma.loan.findMany.mockResolvedValue([]);

    await request(app.getHttpServer())
      .post('/webhooks/palmpay/collection/va')
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

  it('writes unmatched "multiple_active_loans" when user has 2+ ACTIVE loans AND smart-match finds none', async () => {
    prisma.userRepaymentAccount.findUnique.mockResolvedValue({ user_id: USER_ID } as never);
    prisma.loan.findMany.mockResolvedValue([{ id: LOAN_ID }, { id: 'loan-uuid-002' }] as never);
    loans.findActiveLoanMatchingOutstanding.mockResolvedValue(null);

    await request(app.getHttpServer())
      .post('/webhooks/palmpay/collection/va')
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

  it('auto-credits via smart-match when user has 2+ ACTIVE loans AND one outstanding equals the inflow', async () => {
    prisma.userRepaymentAccount.findUnique.mockResolvedValue({ user_id: USER_ID } as never);
    prisma.loan.findMany.mockResolvedValue([{ id: LOAN_ID }, { id: 'loan-uuid-002' }] as never);
    loans.findActiveLoanMatchingOutstanding.mockResolvedValue({
      loan_id:    'loan-uuid-002',
      tiebreaker: 'unique',
    });
    prisma.inflow.upsert.mockResolvedValue({ id: 'inflow-uuid-001', is_matched: false } as never);

    await request(app.getHttpServer())
      .post('/webhooks/palmpay/collection/va')
      .send(COLLECTION_NOTIFICATION)
      .expect(200);

    expect(loans.findActiveLoanMatchingOutstanding).toHaveBeenCalledWith(USER_ID, expect.anything());
    expect(loans.creditInflow).toHaveBeenCalledWith(
      expect.objectContaining({
        loan_id:      'loan-uuid-002',  // smart-match's pick, not active_loans[0]
        match_method: 'AUTO_AMOUNT',
      }),
    );
    // Did NOT persist as unmatched.
    const upsert_calls = prisma.inflow.upsert.mock.calls as unknown as Array<[{ create: { is_matched: boolean } }]>;
    expect(upsert_calls.every((c) => c[0].create.is_matched === false)).toBe(true);
    expect(upsert_calls.length).toBe(1);
  });

  it('auto-credits via creditInflow with AUTO_AMOUNT when user has exactly one ACTIVE loan', async () => {
    prisma.userRepaymentAccount.findUnique.mockResolvedValue({ user_id: USER_ID } as never);
    prisma.loan.findMany.mockResolvedValue([ACTIVE_LOAN] as never);
    prisma.inflow.upsert.mockResolvedValue({ id: 'inflow-uuid-001', is_matched: false } as never);

    await request(app.getHttpServer())
      .post('/webhooks/palmpay/collection/va')
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
      .post('/webhooks/palmpay/collection/va')
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
      .post('/webhooks/palmpay/collection/va')
      .send(COLLECTION_NOTIFICATION)
      .expect(200);

    expect(res.text).toBe('success');
  });

  // ── ops alerts ─────────────────────────────────────────────────────────────

  it('pages ops via OpsAlertsService when an inflow is unmatched (e.g. no user for VA)', async () => {
    prisma.userRepaymentAccount.findUnique.mockResolvedValue(null);

    await request(app.getHttpServer())
      .post('/webhooks/palmpay/collection/va')
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
      .post('/webhooks/palmpay/collection/va')
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
      .post('/webhooks/palmpay/collection/va')
      .send(COLLECTION_NOTIFICATION)
      .expect(200);

    expect(ops_alerts.alertUnmatchedInflow).not.toHaveBeenCalled();
  });
});
