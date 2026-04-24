import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { mock, MockProxy } from 'jest-mock-extended';
import { OpsAlertsService } from '@/modules/ops-alerts/ops-alerts.service';
import { EMAIL_PROVIDER, type EmailProvider } from '@/modules/auth/email.provider.interface';

describe('OpsAlertsService', () => {
  let service: OpsAlertsService;
  let email:   MockProxy<EmailProvider>;
  let config:  MockProxy<ConfigService>;

  const ALERT_RECIPIENT = 'ops@bitmonie.com';

  beforeEach(async () => {
    email  = mock<EmailProvider>();
    config = mock<ConfigService>();

    config.get.mockImplementation((key: string) =>
      key === 'app' ? { internal_alert_email: ALERT_RECIPIENT } : undefined,
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpsAlertsService,
        { provide: EMAIL_PROVIDER, useValue: email },
        { provide: ConfigService,  useValue: config },
      ],
    }).compile();

    service = module.get(OpsAlertsService);
  });

  // ── happy path ────────────────────────────────────────────────────────────

  it('sends email with subject including provider + reason', async () => {
    await service.alertUnmatchedInflow({
      reason:          'no_user_for_va',
      provider:        'palmpay',
      order_no:        'order-001',
      amount_ngn:      '50000.00',
      user_id:         null,
      virtual_account: '9012345678',
    });

    expect(email.sendTransactional).toHaveBeenCalledWith(
      expect.objectContaining({
        to:      ALERT_RECIPIENT,
        subject: '[Bitmonie ops] Unmatched palmpay inflow — no_user_for_va',
      }),
    );
  });

  it('includes all known facts in both text_body and html_body', async () => {
    await service.alertUnmatchedInflow({
      reason:          'multiple_active_loans',
      provider:        'palmpay',
      order_no:        'order-002',
      amount_ngn:      '75000.00',
      user_id:         'user-uuid-001',
      virtual_account: '9099999999',
      payer_name:      'Ada Obi',
      payer_account:   '0123456789',
    });

    const arg = email.sendTransactional.mock.calls[0]![0]!;
    expect(arg.text_body).toContain('order-002');
    expect(arg.text_body).toContain('75000.00');
    expect(arg.text_body).toContain('user-uuid-001');
    expect(arg.text_body).toContain('Ada Obi');
    expect(arg.html_body).toContain('order-002');
    expect(arg.html_body).toContain('user-uuid-001');
    expect(arg.html_body).toContain('Ada Obi');
  });

  it('escapes HTML in user-controlled fields (defends against payer_name injection)', async () => {
    await service.alertUnmatchedInflow({
      reason:          'no_active_loans',
      provider:        'palmpay',
      order_no:        'order-003',
      amount_ngn:      '20000.00',
      user_id:         'user-uuid-001',
      virtual_account: '9088888888',
      payer_name:      '<script>alert(1)</script>',
    });

    const arg = email.sendTransactional.mock.calls[0]![0]!;
    expect(arg.html_body).not.toContain('<script>');
    expect(arg.html_body).toContain('&lt;script&gt;');
  });

  it('includes loan_id and detail when provided (credit_failed path)', async () => {
    await service.alertUnmatchedInflow({
      reason:          'credit_failed',
      provider:        'palmpay',
      order_no:        'order-004',
      amount_ngn:      '100000.00',
      user_id:         'user-uuid-001',
      virtual_account: '9077777777',
      loan_id:         'loan-uuid-001',
      detail:          'DB locked',
    });

    const arg = email.sendTransactional.mock.calls[0]![0]!;
    expect(arg.text_body).toContain('loan-uuid-001');
    expect(arg.text_body).toContain('DB locked');
  });

  // ── degraded paths ────────────────────────────────────────────────────────

  it('skips silently when INTERNAL_ALERT_EMAIL is unset (dev / local)', async () => {
    config.get.mockReturnValue({ internal_alert_email: '' });

    await service.alertUnmatchedInflow({
      reason:          'no_user_for_va',
      provider:        'palmpay',
      order_no:        'order-005',
      amount_ngn:      '50000.00',
      user_id:         null,
      virtual_account: '9011111111',
    });

    expect(email.sendTransactional).not.toHaveBeenCalled();
  });

  it('swallows email send errors (alert is best-effort, must not propagate to caller)', async () => {
    email.sendTransactional.mockRejectedValue(new Error('Mailgun 503'));

    await expect(
      service.alertUnmatchedInflow({
        reason:          'no_user_for_va',
        provider:        'palmpay',
        order_no:        'order-006',
        amount_ngn:      '50000.00',
        user_id:         null,
        virtual_account: '9022222222',
      }),
    ).resolves.toBeUndefined();
  });
});
