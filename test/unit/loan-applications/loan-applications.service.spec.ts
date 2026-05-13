import { Test, TestingModule } from '@nestjs/testing';
import { mock, MockProxy } from 'jest-mock-extended';
import type { LoanApplication } from '@prisma/client';
import { LoanApplicationCollateralType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { LoanApplicationsService } from '@/modules/loan-applications/loan-applications.service';
import { LoanApplicationsRepository } from '@/modules/loan-applications/loan-applications.repository';
import { OpsAlertsService } from '@/modules/ops-alerts/ops-alerts.service';

function make_row(overrides: Partial<LoanApplication> = {}): LoanApplication {
  const now = new Date('2026-05-13T10:00:00.000Z');
  return {
    id:                      'app-uuid-001',
    created_at:              now,
    updated_at:              now,
    first_name:              'Ada',
    last_name:               'Lovelace',
    email:                   'ada@example.com',
    phone:                   '+2348035551234',
    collateral_type:         LoanApplicationCollateralType.BITCOIN,
    collateral_description:  '0.05 BTC',
    loan_amount_ngn:         new Prisma.Decimal('5000000.00'),
    status:                  'NEW',
    assigned_to_ops_user_id: null,
    notes:                   null,
    client_ip:               '203.0.113.5',
    user_agent:              'jest',
    ...overrides,
  };
}

describe('LoanApplicationsService', () => {
  let service: LoanApplicationsService;
  let repo:    MockProxy<LoanApplicationsRepository>;
  let alerts:  MockProxy<OpsAlertsService>;

  beforeEach(async () => {
    repo   = mock<LoanApplicationsRepository>();
    alerts = mock<OpsAlertsService>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoanApplicationsService,
        { provide: LoanApplicationsRepository, useValue: repo },
        { provide: OpsAlertsService,            useValue: alerts },
      ],
    }).compile();

    service = module.get(LoanApplicationsService);
  });

  describe('create', () => {
    it('persists the application, mapping display string to enum', async () => {
      const row = make_row();
      repo.create.mockResolvedValue(row);
      alerts.alertNewLoanApplication.mockResolvedValue();

      const result = await service.create({
        first_name:              'Ada',
        last_name:               'Lovelace',
        email:                   'ada@example.com',
        phone:                   '+2348035551234',
        collateral_type_display: 'Bitcoin (BTC)',
        collateral_description:  '0.05 BTC',
        loan_amount_ngn:         5_000_000,
        client_ip:               '203.0.113.5',
        user_agent:              'jest',
      });

      expect(result).toEqual(row);
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          collateral_type: LoanApplicationCollateralType.BITCOIN,
        }),
      );
      // Decimal conversion: number → decimal.js → Prisma.Decimal-compatible
      const passed = repo.create.mock.calls[0][0];
      expect(passed.loan_amount_ngn).toBeInstanceOf(Decimal);
      expect(passed.loan_amount_ngn.toString()).toBe('5000000');
    });

    it('dispatches an ops alert with formatted amount + display string', async () => {
      repo.create.mockResolvedValue(make_row());
      alerts.alertNewLoanApplication.mockResolvedValue();

      await service.create({
        first_name:              'Ada',
        last_name:               'Lovelace',
        email:                   'ada@example.com',
        phone:                   '+2348035551234',
        collateral_type_display: 'Bitcoin (BTC)',
        collateral_description:  '0.05 BTC',
        loan_amount_ngn:         5_000_000,
        client_ip:               '203.0.113.5',
        user_agent:              'jest',
      });

      // Email is fire-and-forget — wait a microtask so the .then/.catch chain settles.
      await Promise.resolve();

      expect(alerts.alertNewLoanApplication).toHaveBeenCalledWith(
        expect.objectContaining({
          application_id:          'app-uuid-001',
          collateral_type_display: 'Bitcoin (BTC)',
          loan_amount_ngn:         '5,000,000',
        }),
      );
    });

    it('does not throw when the ops alert email fails (fire-and-forget)', async () => {
      repo.create.mockResolvedValue(make_row());
      alerts.alertNewLoanApplication.mockRejectedValue(new Error('SMTP unreachable'));

      // Awaiting create must NOT propagate the email error — only persistence is required.
      await expect(
        service.create({
          first_name:              'Ada',
          last_name:               'Lovelace',
          email:                   'ada@example.com',
          phone:                   '+2348035551234',
          collateral_type_display: 'Bitcoin (BTC)',
          collateral_description:  '0.05 BTC',
          loan_amount_ngn:         5_000_000,
          client_ip:               null,
          user_agent:              null,
        }),
      ).resolves.toBeTruthy();

      // Drain microtasks so the .catch fires before the test ends and avoid an
      // unhandled-rejection warning.
      await Promise.resolve();
      await Promise.resolve();
    });

    it('maps every supported collateral display string to its enum', async () => {
      const cases: Array<[string, LoanApplicationCollateralType]> = [
        ['Bitcoin (BTC)',         LoanApplicationCollateralType.BITCOIN],
        ['USDT / USDC',           LoanApplicationCollateralType.USDT_USDC],
        ['MacBook (M1 or newer)', LoanApplicationCollateralType.MACBOOK_M1_OR_NEWER],
        ['iPhone (13 or newer)',  LoanApplicationCollateralType.IPHONE_13_OR_NEWER],
        ['Car (2008 or newer)',   LoanApplicationCollateralType.CAR_2008_OR_NEWER],
      ];

      for (const [display, enum_value] of cases) {
        repo.create.mockResolvedValue(make_row({ collateral_type: enum_value }));
        alerts.alertNewLoanApplication.mockResolvedValue();

        await service.create({
          first_name:              'Ada',
          last_name:               'Lovelace',
          email:                   'ada@example.com',
          phone:                   '+2348035551234',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          collateral_type_display: display as any,
          collateral_description:  'whatever',
          loan_amount_ngn:         100_000,
          client_ip:               null,
          user_agent:              null,
        });

        const last_call = repo.create.mock.calls.at(-1);
        expect(last_call?.[0].collateral_type).toBe(enum_value);
      }
    });
  });
});
