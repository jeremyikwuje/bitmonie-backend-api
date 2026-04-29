import { Test, TestingModule } from '@nestjs/testing';
import { WebhooksLogService, WebhookOutcome } from '@/modules/webhooks-log/webhooks-log.service';
import { PrismaService } from '@/database/prisma.service';

function make_prisma() {
  return {
    webhookLog: {
      create: jest.fn(),
      update: jest.fn(),
    },
  };
}

describe('WebhooksLogService', () => {
  let service: WebhooksLogService;
  let prisma:  ReturnType<typeof make_prisma>;

  beforeEach(async () => {
    prisma = make_prisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhooksLogService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(WebhooksLogService);
  });

  // ── record() ────────────────────────────────────────────────────────────────

  describe('record', () => {
    it('inserts a row with outcome=RECEIVED and returns its id', async () => {
      prisma.webhookLog.create.mockResolvedValue({ id: 'log-uuid-1' });

      const id = await service.record({
        provider:    'palmpay',
        http_method: 'POST',
        http_path:   '/v1/webhooks/palmpay',
        headers:     { 'content-type': 'application/json', 'x-request-id': 'req_1' },
        raw_body:    JSON.stringify({ orderNo: 'abc' }),
      });

      expect(id).toBe('log-uuid-1');
      expect(prisma.webhookLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          provider:    'palmpay',
          http_method: 'POST',
          http_path:   '/v1/webhooks/palmpay',
          outcome:     WebhookOutcome.RECEIVED,
          body_length: expect.any(Number),
        }),
      });
    });

    it('redacts PII fields (payerAccountNo, bankAccNo, licenseNumber) in the stored body', async () => {
      prisma.webhookLog.create.mockResolvedValue({ id: 'log-uuid-1' });

      const body = JSON.stringify({
        orderNo:        'abc',
        payerAccountNo: '0123456789',
        nested: {
          bankAccNo:     '9876543210',
          licenseNumber: '12345678901',
          orderId:       'safe-value',
        },
      });

      await service.record({
        provider:    'palmpay',
        http_method: 'POST',
        http_path:   '/v1/webhooks/palmpay',
        raw_body:    body,
      });

      const stored = prisma.webhookLog.create.mock.calls[0][0].data.raw_body as string;
      const parsed = JSON.parse(stored) as Record<string, unknown>;

      expect(parsed.payerAccountNo).toBe('****6789');
      expect((parsed.nested as Record<string, unknown>).bankAccNo).toBe('****3210');
      expect((parsed.nested as Record<string, unknown>).licenseNumber).toBe('****8901');
      // Non-PII fields stay intact.
      expect(parsed.orderNo).toBe('abc');
      expect((parsed.nested as Record<string, unknown>).orderId).toBe('safe-value');
    });

    it('only stores allow-listed headers (drops auth/secret-bearing headers)', async () => {
      prisma.webhookLog.create.mockResolvedValue({ id: 'log-uuid-1' });

      await service.record({
        provider:    'blink',
        http_method: 'POST',
        http_path:   '/v1/webhooks/blink',
        headers: {
          'content-type':  'application/json',
          'svix-id':       'msg_123',
          'authorization': 'Bearer SECRET-NEVER-STORE',
          'cookie':        'session=secret',
          'x-api-key':     'SECRET',
        },
        raw_body: '{}',
      });

      const stored = prisma.webhookLog.create.mock.calls[0][0].data.headers as Record<string, string>;
      expect(stored['content-type']).toBe('application/json');
      expect(stored['svix-id']).toBe('msg_123');
      expect(stored).not.toHaveProperty('authorization');
      expect(stored).not.toHaveProperty('cookie');
      expect(stored).not.toHaveProperty('x-api-key');
    });

    it('stores body verbatim when not valid JSON (still useful as a diagnostic)', async () => {
      prisma.webhookLog.create.mockResolvedValue({ id: 'log-uuid-1' });

      await service.record({
        provider:    'palmpay',
        http_method: 'POST',
        http_path:   '/v1/webhooks/palmpay',
        raw_body:    'not-json-here',
      });

      expect(prisma.webhookLog.create.mock.calls[0][0].data.raw_body).toBe('not-json-here');
    });

    it('returns empty string and does NOT throw when DB insert fails (best-effort)', async () => {
      prisma.webhookLog.create.mockRejectedValue(new Error('DB unavailable'));

      const id = await service.record({
        provider:    'palmpay',
        http_method: 'POST',
        http_path:   '/v1/webhooks/palmpay',
        raw_body:    '{}',
      });

      expect(id).toBe('');
    });
  });

  // ── updateOutcome() ─────────────────────────────────────────────────────────

  describe('updateOutcome', () => {
    it('updates outcome + processed_at when id is non-empty', async () => {
      prisma.webhookLog.update.mockResolvedValue({});

      await service.updateOutcome('log-uuid-1', {
        outcome:            WebhookOutcome.PROCESSED,
        outcome_detail:     'outflow → SUCCESSFUL',
        external_reference: 'palmpay-order-123',
        signature_valid:    true,
      });

      expect(prisma.webhookLog.update).toHaveBeenCalledWith({
        where: { id: 'log-uuid-1' },
        data: expect.objectContaining({
          outcome:            WebhookOutcome.PROCESSED,
          outcome_detail:     'outflow → SUCCESSFUL',
          external_reference: 'palmpay-order-123',
          signature_valid:    true,
          processed_at:       expect.any(Date),
        }),
      });
    });

    it('no-ops on empty id (record() returned empty because DB was down)', async () => {
      await service.updateOutcome('', { outcome: WebhookOutcome.PROCESSED });
      expect(prisma.webhookLog.update).not.toHaveBeenCalled();
    });

    it('does not throw when the update itself fails (row stays in RECEIVED)', async () => {
      prisma.webhookLog.update.mockRejectedValue(new Error('connection lost'));

      await expect(
        service.updateOutcome('log-uuid-1', { outcome: WebhookOutcome.PROCESSED }),
      ).resolves.toBeUndefined();
    });
  });
});
