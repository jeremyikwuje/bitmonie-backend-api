import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { mock, MockProxy } from 'jest-mock-extended';
import { OutflowStatus } from '@prisma/client';
import { PalmpayPayoutWebhookController } from '@/modules/webhooks/palmpay-payout.webhook.controller';
import { PalmpayProvider } from '@/providers/palmpay/palmpay.provider';
import { OutflowsService } from '@/modules/disbursements/outflows.service';
import { WebhooksLogService } from '@/modules/webhooks-log/webhooks-log.service';
import { PrismaService } from '@/database/prisma.service';
import { GlobalExceptionFilter } from '@/common/filters/global-exception.filter';

const DISB_ID      = 'disb-uuid-001';
const OUTFLOW_ID   = 'outflow-uuid-001';
const PROVIDER_REF = `outflow-1-${DISB_ID}`;

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

const OUTFLOW_ROW = {
  id:                 OUTFLOW_ID,
  disbursement_id:    DISB_ID,
  provider_reference: PROVIDER_REF,
  status:             OutflowStatus.PROCESSING,
};

function makePrisma() {
  return {
    outflow: { findUnique: jest.fn().mockResolvedValue(OUTFLOW_ROW) },
  };
}

describe('PalmpayPayoutWebhookController', () => {
  let app: INestApplication;
  let provider:     MockProxy<PalmpayProvider>;
  let outflows:     MockProxy<OutflowsService>;
  let webhooks_log: MockProxy<WebhooksLogService>;
  let prisma:       ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma       = makePrisma();
    provider     = mock<PalmpayProvider>();
    outflows     = mock<OutflowsService>();
    webhooks_log = mock<WebhooksLogService>();
    webhooks_log.record.mockResolvedValue('webhook-log-id');
    webhooks_log.updateOutcome.mockResolvedValue();

    provider.verifyWebhookSignature.mockReturnValue(true);
    provider.getTransferStatus.mockResolvedValue({ status: 'successful' });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PalmpayPayoutWebhookController],
      providers: [
        { provide: PalmpayProvider,    useValue: provider },
        { provide: OutflowsService,    useValue: outflows },
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
      .post('/webhooks/palmpay/payout')
      .send(PAYOUT_NOTIFICATION)
      .expect(401);

    expect(outflows.handleSuccess).not.toHaveBeenCalled();
  });

  it('verifies signature on raw body before any parsing', async () => {
    provider.verifyWebhookSignature.mockReturnValue(false);

    await request(app.getHttpServer())
      .post('/webhooks/palmpay/payout')
      .send(PAYOUT_NOTIFICATION)
      .expect(401);

    expect(provider.verifyWebhookSignature).toHaveBeenCalledWith(expect.any(String), '');
  });

  // ── response format ─────────────────────────────────────────────────────────

  it('responds with plain text "success" as required by PalmPay', async () => {
    const res = await request(app.getHttpServer())
      .post('/webhooks/palmpay/payout')
      .send(PAYOUT_NOTIFICATION)
      .expect(200);

    expect(res.text).toBe('success');
  });

  // ── payout notification (status verification) ───────────────────────────────

  it('queries PalmPay transfer status before acting on payout webhook', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/palmpay/payout')
      .send(PAYOUT_NOTIFICATION)
      .expect(200);

    expect(provider.getTransferStatus).toHaveBeenCalledWith(PROVIDER_REF);
  });

  it('calls handleSuccess when status query returns "successful"', async () => {
    provider.getTransferStatus.mockResolvedValue({ status: 'successful' });

    await request(app.getHttpServer())
      .post('/webhooks/palmpay/payout')
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
      .post('/webhooks/palmpay/payout')
      .send(PAYOUT_NOTIFICATION)
      .expect(200);

    expect(outflows.handleFailure).toHaveBeenCalledWith(
      OUTFLOW_ID, DISB_ID, 'Account not found', 'ERR_001',
    );
  });

  it('defers processing when status query returns "processing" (webhook was premature)', async () => {
    provider.getTransferStatus.mockResolvedValue({ status: 'processing' });

    await request(app.getHttpServer())
      .post('/webhooks/palmpay/payout')
      .send(PAYOUT_NOTIFICATION)
      .expect(200);

    expect(outflows.handleSuccess).not.toHaveBeenCalled();
    expect(outflows.handleFailure).not.toHaveBeenCalled();
  });

  it('defers processing when status query throws (network error) — PalmPay will retry', async () => {
    provider.getTransferStatus.mockRejectedValue(new Error('PalmPay API timeout'));

    await request(app.getHttpServer())
      .post('/webhooks/palmpay/payout')
      .send(PAYOUT_NOTIFICATION)
      .expect(200);

    expect(outflows.handleSuccess).not.toHaveBeenCalled();
    expect(outflows.handleFailure).not.toHaveBeenCalled();
  });

  // ── payout idempotency ─────────────────────────────────────────────────────

  it('skips status query when Outflow is already SUCCESSFUL', async () => {
    prisma.outflow.findUnique.mockResolvedValue({ ...OUTFLOW_ROW, status: OutflowStatus.SUCCESSFUL });

    await request(app.getHttpServer())
      .post('/webhooks/palmpay/payout')
      .send(PAYOUT_NOTIFICATION)
      .expect(200);

    expect(provider.getTransferStatus).not.toHaveBeenCalled();
    expect(outflows.handleSuccess).not.toHaveBeenCalled();
  });

  it('skips status query when Outflow is already FAILED', async () => {
    prisma.outflow.findUnique.mockResolvedValue({ ...OUTFLOW_ROW, status: OutflowStatus.FAILED });

    await request(app.getHttpServer())
      .post('/webhooks/palmpay/payout')
      .send(PAYOUT_NOTIFICATION)
      .expect(200);

    expect(provider.getTransferStatus).not.toHaveBeenCalled();
    expect(outflows.handleFailure).not.toHaveBeenCalled();
  });

  it('returns success when outflow not found (unknown reference)', async () => {
    prisma.outflow.findUnique.mockResolvedValue(null);

    await request(app.getHttpServer())
      .post('/webhooks/palmpay/payout')
      .send(PAYOUT_NOTIFICATION)
      .expect(200);

    expect(provider.getTransferStatus).not.toHaveBeenCalled();
  });

  // The outflow reference format was changed from "{uuid}:outflow:{n}" to
  // "outflow-{n}-{uuid}". Until every pre-rename outflow is terminal, the
  // discriminator regex must still route the legacy form to the payout
  // handler. The endpoint accepts both shapes — the schema-level orderId
  // string is what matters; lookup by provider_reference handles the rest.
  it('accepts the legacy ":outflow:" reference shape on the payout endpoint', async () => {
    const legacy_ref = `${DISB_ID}:outflow:1`;
    prisma.outflow.findUnique.mockResolvedValue({ ...OUTFLOW_ROW, provider_reference: legacy_ref });
    provider.getTransferStatus.mockResolvedValue({ status: 'successful' });

    await request(app.getHttpServer())
      .post('/webhooks/palmpay/payout')
      .send({ ...PAYOUT_NOTIFICATION, orderId: legacy_ref })
      .expect(200);

    expect(provider.getTransferStatus).toHaveBeenCalledWith(legacy_ref);
  });
});
