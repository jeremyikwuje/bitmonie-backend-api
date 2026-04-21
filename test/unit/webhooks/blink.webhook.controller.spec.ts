import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { mock, MockProxy } from 'jest-mock-extended';
import { PaymentNetwork, PaymentRequestStatus } from '@prisma/client';
import Decimal from 'decimal.js';
import { BlinkWebhookController } from '@/modules/webhooks/blink.webhook.controller';
import { BlinkProvider } from '@/providers/blink/blink.provider';
import { InflowsService } from '@/modules/inflows/inflows.service';
import { LoansService } from '@/modules/loans/loans.service';
import { DisbursementsService } from '@/modules/disbursements/disbursements.service';
import { OutflowsService } from '@/modules/disbursements/outflows.service';
import { GlobalExceptionFilter } from '@/common/filters/global-exception.filter';

const PAYMENT_HASH = 'pay_hash_001';
const LOAN_ID      = 'loan-uuid-001';
const DISB_ID      = 'disb-uuid-001';
const USER_ID      = 'user-uuid-001';

const VALID_RAW_BODY = JSON.stringify({
  accountId:  'blink-account-001',
  eventType:  'receive.lightning',
  walletId:   'btc-wallet-id',
  transaction: {
    initiationVia: {
      type:        'Lightning',
      paymentHash: PAYMENT_HASH,
    },
    status:             'SUCCESS',
    settlementAmount:   386598,
    settlementCurrency: 'BTC',
  },
});

const SVIX_HEADERS = {
  'svix-id':        'msg_001',
  'svix-timestamp': String(Math.floor(Date.now() / 1000)),
  'svix-signature': 'v1,valid_sig',
};

const LOAN_PAYMENT_REQUEST = {
  id:          'pr-uuid-001',
  user_id:     USER_ID,
  source_type: 'LOAN',
  source_id:   LOAN_ID,
  status:      PaymentRequestStatus.PAID,
  receiving_address: PAYMENT_HASH,
  expires_at:  new Date(Date.now() + 1800_000),
};

const CREATED_INFLOW = {
  id:                 'inflow-uuid-001',
  user_id:            null,
  asset:              'SAT',
  amount:             new Decimal('386598'),
  currency:           'SAT',
  network:            PaymentNetwork.LIGHTNING,
  receiving_address:  PAYMENT_HASH,
  provider_reference: PAYMENT_HASH,
  is_matched:         true,
  matched_at:         new Date(),
  source_type:        'LOAN',
  source_id:          LOAN_ID,
} as never;

const DISBURSEMENT_ACCOUNT = {
  provider_name:  'GTBank',
  account_unique: '0123456789',
  account_holder_name: 'Ada Obi',
} as never;

describe('BlinkWebhookController', () => {
  let app: INestApplication;
  let provider:       MockProxy<BlinkProvider>;
  let inflows:        MockProxy<InflowsService>;
  let loans:          MockProxy<LoansService>;
  let disbursements:  MockProxy<DisbursementsService>;
  let outflows:       MockProxy<OutflowsService>;

  beforeEach(async () => {
    provider      = mock<BlinkProvider>();
    inflows       = mock<InflowsService>();
    loans         = mock<LoansService>();
    disbursements = mock<DisbursementsService>();
    outflows      = mock<OutflowsService>();

    provider.verifyWebhookSignature.mockReturnValue(true);
    provider.isOwnAccount.mockReturnValue(true);
    inflows.ingest.mockResolvedValue({ inflow: CREATED_INFLOW, payment_request: LOAN_PAYMENT_REQUEST as never });
    loans.getLoan.mockResolvedValue({
      id:                      LOAN_ID,
      user_id:                 USER_ID,
      disbursement_account_id: 'acct-uuid-001',
      disbursement_account:    DISBURSEMENT_ACCOUNT,
    } as never);
    disbursements.createForLoan.mockResolvedValue({ id: DISB_ID } as never);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BlinkWebhookController],
      providers: [
        { provide: BlinkProvider,       useValue: provider },
        { provide: InflowsService,       useValue: inflows },
        { provide: LoansService,         useValue: loans },
        { provide: DisbursementsService, useValue: disbursements },
        { provide: OutflowsService,      useValue: outflows },
      ],
    }).compile();

    app = module.createNestApplication({ rawBody: true });
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
  });

  afterEach(() => app.close());

  it('returns 401 when signature is invalid', async () => {
    provider.verifyWebhookSignature.mockReturnValue(false);

    await request(app.getHttpServer())
      .post('/webhooks/blink')
      .set(SVIX_HEADERS)
      .send(VALID_RAW_BODY)
      .expect(401);

    expect(inflows.ingest).not.toHaveBeenCalled();
  });

  it('verifies signature on the raw body using svix headers', async () => {
    provider.verifyWebhookSignature.mockReturnValue(false);

    await request(app.getHttpServer())
      .post('/webhooks/blink')
      .set(SVIX_HEADERS)
      .send(VALID_RAW_BODY)
      .expect(401);

    expect(provider.verifyWebhookSignature).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('svix-id'),
    );
  });

  it('returns 200 on a valid LOAN webhook', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/blink')
      .set(SVIX_HEADERS)
      .send(VALID_RAW_BODY)
      .expect(200);
  });

  it('calls InflowsService.ingest with receiving_address from payload', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/blink')
      .set(SVIX_HEADERS)
      .send(VALID_RAW_BODY)
      .expect(200);

    expect(inflows.ingest).toHaveBeenCalledWith(
      expect.objectContaining({ receiving_address: PAYMENT_HASH }),
    );
  });

  it('activates loan and dispatches disbursement when source_type is LOAN', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/blink')
      .set(SVIX_HEADERS)
      .send(VALID_RAW_BODY)
      .expect(200);

    expect(loans.activateLoan).toHaveBeenCalledWith(LOAN_ID, expect.any(Date));
    expect(disbursements.createForLoan).toHaveBeenCalled();
    expect(outflows.dispatch).toHaveBeenCalledWith(DISB_ID);
  });

  it('skips loan actions when source_type is not LOAN (future offramp flow)', async () => {
    inflows.ingest.mockResolvedValue({
      inflow:           CREATED_INFLOW,
      payment_request:  { ...LOAN_PAYMENT_REQUEST, source_type: 'OFFRAMP' } as never,
    });

    await request(app.getHttpServer())
      .post('/webhooks/blink')
      .set(SVIX_HEADERS)
      .send(VALID_RAW_BODY)
      .expect(200);

    expect(loans.activateLoan).not.toHaveBeenCalled();
    expect(disbursements.createForLoan).not.toHaveBeenCalled();
  });

  it('is idempotent — skips post-match actions when payment_request is null', async () => {
    inflows.ingest.mockResolvedValue({ inflow: CREATED_INFLOW, payment_request: null });

    await request(app.getHttpServer())
      .post('/webhooks/blink')
      .set(SVIX_HEADERS)
      .send(VALID_RAW_BODY)
      .expect(200);

    expect(loans.activateLoan).not.toHaveBeenCalled();
    expect(disbursements.createForLoan).not.toHaveBeenCalled();
  });
});
