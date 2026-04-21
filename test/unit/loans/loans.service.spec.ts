import Decimal from 'decimal.js';
import { Test, TestingModule } from '@nestjs/testing';
import { mock, MockProxy } from 'jest-mock-extended';
import {
  DisbursementAccountKind,
  DisbursementAccountStatus,
  DisbursementRail,
  LoanStatus,
  PaymentNetwork,
  PaymentRequestStatus,
} from '@prisma/client';
import type { User } from '@prisma/client';
import { LoansService } from '@/modules/loans/loans.service';
import { LoanStatusService } from '@/modules/loans/loan-status.service';
import { CalculatorService } from '@/modules/loans/calculator.service';
import { PriceFeedService } from '@/modules/price-feed/price-feed.service';
import { PaymentRequestsService } from '@/modules/payment-requests/payment-requests.service';
import { PrismaService } from '@/database/prisma.service';
import {
  LoanDisbursementAccountRequiredException,
  LoanDisabledException,
  LoanNotFoundException,
  DisbursementDisabledException,
  CollateralInvoiceFailedException,
  LoanInvalidTransitionException,
} from '@/common/errors/bitmonie.errors';

const USER_ID   = 'user-uuid-001';
const LOAN_ID   = 'loan-uuid-001';
const ACCT_ID   = 'acct-uuid-001';

const ACTIVE_USER: User = {
  id:                   USER_ID,
  email:                'ada@test.com',
  email_verified:       true,
  password_hash:        'hash',
  totp_secret:          null,
  totp_enabled:         false,
  country:              'NG',
  is_active:            true,
  disbursement_enabled: true,
  loan_enabled:         true,
  kyc_tier:             1,
  first_name:           'Ada',
  middle_name:          null,
  last_name:            'Obi',
  date_of_birth:        null,
  created_at:           new Date(),
  updated_at:           new Date(),
};

const DEFAULT_ACCOUNT = {
  id:                  ACCT_ID,
  user_id:             USER_ID,
  kind:                DisbursementAccountKind.BANK,
  currency:            'NGN',
  provider_name:       'GTBank',
  provider_code:       '058',
  account_unique:      '0123456789',
  account_unique_tag:  null,
  network:             null,
  label:               null,
  account_holder_name: 'Ada Obi',
  name_match_score:    0.95,
  is_default:          true,
  status:              DisbursementAccountStatus.VERIFIED,
  verified_at:         new Date(),
  created_at:          new Date(),
  updated_at:          new Date(),
};

const DB_LOAN = {
  id:                       LOAN_ID,
  user_id:                  USER_ID,
  disbursement_account_id:  ACCT_ID,
  status:                   LoanStatus.PENDING_COLLATERAL,
  collateral_amount_sat:    BigInt(386598),
  collateral_received_at:   null,
  disbursement_id:          null,
  status_logs:              [],
  due_at:                   new Date(Date.now() + 7 * 86400_000),
  created_at:               new Date(),
  updated_at:               new Date(),
} as never;

const DB_PAYMENT_REQUEST = {
  id:                PR_ID(),
  user_id:           USER_ID,
  status:            PaymentRequestStatus.PENDING,
  receiving_address: 'pay_hash_001',
  payment_request:   'lnbc300000stub',
  expires_at:        new Date(Date.now() + 1800_000),
  source_type:       'LOAN',
  source_id:         LOAN_ID,
} as never;

function PR_ID() { return 'pr-uuid-001'; }

function make_prisma() {
  return {
    disbursementAccount: {
      findFirst: jest.fn().mockResolvedValue(DEFAULT_ACCOUNT),
    },
    loan: {
      create:            jest.fn().mockResolvedValue(DB_LOAN),
      findFirst:         jest.fn().mockResolvedValue(DB_LOAN),
      findUniqueOrThrow: jest.fn().mockResolvedValue(DB_LOAN),
      update:            jest.fn().mockResolvedValue(DB_LOAN),
    },
    $transaction: jest.fn().mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          loan:          { create: jest.fn().mockResolvedValue(DB_LOAN), update: jest.fn().mockResolvedValue({}) },
          loanStatusLog: { create: jest.fn().mockResolvedValue({}) },
        }),
    ),
  };
}

describe('LoansService', () => {
  let service: LoansService;
  let prisma: ReturnType<typeof make_prisma>;
  let price_feed: MockProxy<PriceFeedService>;
  let loan_status: MockProxy<LoanStatusService>;
  let payment_requests: MockProxy<PaymentRequestsService>;

  const SAT_RATE  = new Decimal('0.97');
  const USDT_RATE = new Decimal('1410');

  const CHECKOUT_DTO = {
    principal_ngn:  300_000,
    duration_days:  7,
    principal_decimal: new Decimal('300000'),
  } as never;

  beforeEach(async () => {
    prisma = make_prisma();
    price_feed       = mock<PriceFeedService>();
    loan_status      = mock<LoanStatusService>();
    payment_requests = mock<PaymentRequestsService>();

    price_feed.getCurrentRate.mockResolvedValue({ rate_buy: SAT_RATE, rate_sell: SAT_RATE });
    payment_requests.create.mockResolvedValue(DB_PAYMENT_REQUEST);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoansService,
        CalculatorService,
        { provide: PrismaService,          useValue: prisma },
        { provide: PriceFeedService,       useValue: price_feed },
        { provide: LoanStatusService,      useValue: loan_status },
        { provide: PaymentRequestsService, useValue: payment_requests },
      ],
    }).compile();

    service = module.get(LoansService);
  });

  // ── checkoutLoan ──────────────────────────────────────────────────────────────

  describe('checkoutLoan', () => {
    it('throws LoanDisabledException when user.loan_enabled is false', async () => {
      await expect(
        service.checkoutLoan({ ...ACTIVE_USER, loan_enabled: false }, CHECKOUT_DTO),
      ).rejects.toThrow(LoanDisabledException);
    });

    it('throws DisbursementDisabledException when user.disbursement_enabled is false', async () => {
      await expect(
        service.checkoutLoan({ ...ACTIVE_USER, disbursement_enabled: false }, CHECKOUT_DTO),
      ).rejects.toThrow(DisbursementDisabledException);
    });

    it('throws LoanDisbursementAccountRequiredException when no default account', async () => {
      prisma.disbursementAccount.findFirst.mockResolvedValue(null);
      await expect(service.checkoutLoan(ACTIVE_USER, CHECKOUT_DTO)).rejects.toThrow(
        LoanDisbursementAccountRequiredException,
      );
    });

    it('throws LoanPriceStaleException when price feed is stale', async () => {
      const { LoanPriceStaleException } = await import('@/common/errors/bitmonie.errors');
      price_feed.getCurrentRate.mockRejectedValue(new LoanPriceStaleException({ last_updated_ms: 200_000 }));
      await expect(service.checkoutLoan(ACTIVE_USER, CHECKOUT_DTO)).rejects.toThrow(
        LoanPriceStaleException,
      );
    });

    it('creates loan with PENDING_COLLATERAL status in a transaction', async () => {
      await service.checkoutLoan(ACTIVE_USER, CHECKOUT_DTO);
      expect(prisma.$transaction).toHaveBeenCalled();

      const tx_fn = prisma.$transaction.mock.calls[0][0];
      const tx = {
        loan:          { create: jest.fn().mockResolvedValue(DB_LOAN), update: jest.fn() },
        loanStatusLog: { create: jest.fn().mockResolvedValue({}) },
      };
      const result = await tx_fn(tx);
      expect(tx.loan.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: LoanStatus.PENDING_COLLATERAL }),
        }),
      );
      expect(result).toBeDefined();
    });

    it('calls LoanStatusService.transition with LOAN_CREATED reason code', async () => {
      await service.checkoutLoan(ACTIVE_USER, CHECKOUT_DTO);

      expect(loan_status.transition).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          from_status: null,
          to_status:   LoanStatus.PENDING_COLLATERAL,
          reason_code: 'LOAN_CREATED',
        }),
      );
    });

    it('calls PaymentRequestsService.create after loan transaction commits', async () => {
      await service.checkoutLoan(ACTIVE_USER, CHECKOUT_DTO);

      expect(payment_requests.create).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id:     USER_ID,
          source_type: 'LOAN',
          source_id:   LOAN_ID,
        }),
      );
    });

    it('throws CollateralInvoiceFailedException when provider call fails', async () => {
      payment_requests.create.mockRejectedValue(new Error('Blink API error'));
      await expect(service.checkoutLoan(ACTIVE_USER, CHECKOUT_DTO)).rejects.toThrow(
        CollateralInvoiceFailedException,
      );
    });

    it('returns loan_id, payment_request, receiving_address, expires_at, and fee_breakdown', async () => {
      const result = await service.checkoutLoan(ACTIVE_USER, CHECKOUT_DTO);

      expect(result.loan_id).toBe(LOAN_ID);
      expect(result.payment_request).toBe('lnbc300000stub');
      expect(result.receiving_address).toBe('pay_hash_001');
      expect(result.expires_at).toBeInstanceOf(Date);
      expect(result.fee_breakdown).toMatchObject({
        origination_fee_ngn: expect.any(String),
        total_fees_ngn:      expect.any(String),
        duration_days:       7,
      });
    });

    it('uses rate_sell (not rate_buy) for collateral calculation', async () => {
      const sell_rate = new Decimal('1.00');
      const buy_rate  = new Decimal('0.90');
      price_feed.getCurrentRate.mockResolvedValue({ rate_buy: buy_rate, rate_sell: sell_rate });

      await service.checkoutLoan(ACTIVE_USER, CHECKOUT_DTO);

      const tx_fn = prisma.$transaction.mock.calls[0][0];
      const tx = {
        loan:          { create: jest.fn().mockResolvedValue(DB_LOAN), update: jest.fn() },
        loanStatusLog: { create: jest.fn().mockResolvedValue({}) },
      };
      await tx_fn(tx);
      const { data } = tx.loan.create.mock.calls[0][0];
      // At rate 1.00, collateral_sat = ceil(300000 / 0.80 / 1.00) = 375000
      expect(data.collateral_amount_sat).toBe(BigInt(375000));
    });
  });

  // ── getLoan ───────────────────────────────────────────────────────────────────

  describe('getLoan', () => {
    it('returns loan with status_logs when found', async () => {
      prisma.loan.findFirst.mockResolvedValue({ ...(DB_LOAN as object), status_logs: [] } as never);
      const result = await service.getLoan(USER_ID, LOAN_ID);
      expect(result.id).toBe(LOAN_ID);
    });

    it('throws LoanNotFoundException when loan does not belong to user', async () => {
      prisma.loan.findFirst.mockResolvedValue(null);
      await expect(service.getLoan(USER_ID, 'other-loan')).rejects.toThrow(LoanNotFoundException);
    });
  });

  // ── cancelLoan ────────────────────────────────────────────────────────────────

  describe('cancelLoan', () => {
    it('transitions loan to CANCELLED via LoanStatusService', async () => {
      await service.cancelLoan(USER_ID, LOAN_ID);

      expect(loan_status.transition).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          from_status: LoanStatus.PENDING_COLLATERAL,
          to_status:   LoanStatus.CANCELLED,
          reason_code: 'CUSTOMER_CANCELLED',
        }),
      );
    });

    it('throws LoanNotFoundException for unknown loan', async () => {
      prisma.loan.findFirst.mockResolvedValue(null);
      await expect(service.cancelLoan(USER_ID, 'bad-id')).rejects.toThrow(LoanNotFoundException);
    });

    it('propagates LoanInvalidTransitionException from LoanStatusService', async () => {
      loan_status.transition.mockRejectedValue(
        new LoanInvalidTransitionException({ from_status: 'ACTIVE', to_status: 'CANCELLED' }),
      );
      await expect(service.cancelLoan(USER_ID, LOAN_ID)).rejects.toThrow(LoanInvalidTransitionException);
    });
  });

  // ── setReleaseAddress ─────────────────────────────────────────────────────────

  describe('setReleaseAddress', () => {
    it('updates collateral_release_address on the loan', async () => {
      await service.setReleaseAddress(USER_ID, LOAN_ID, 'ada@blink.sv');

      expect(prisma.loan.update).toHaveBeenCalledWith({
        where: { id: LOAN_ID },
        data:  { collateral_release_address: 'ada@blink.sv' },
      });
    });

    it('throws LoanNotFoundException for unknown loan', async () => {
      prisma.loan.findFirst.mockResolvedValue(null);
      await expect(service.setReleaseAddress(USER_ID, 'bad-id', 'addr')).rejects.toThrow(
        LoanNotFoundException,
      );
    });
  });

  // ── activateLoan ──────────────────────────────────────────────────────────────

  describe('activateLoan', () => {
    it('transitions loan to ACTIVE with COLLATERAL_CONFIRMED reason', async () => {
      const now = new Date();
      await service.activateLoan(LOAN_ID, now);

      expect(loan_status.transition).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          from_status:  LoanStatus.PENDING_COLLATERAL,
          to_status:    LoanStatus.ACTIVE,
          triggered_by: 'COLLATERAL_WEBHOOK',
          reason_code:  'COLLATERAL_CONFIRMED',
        }),
      );
    });

    it('sets collateral_received_at in the same transaction', async () => {
      const now = new Date();
      await service.activateLoan(LOAN_ID, now);

      const tx_fn = prisma.$transaction.mock.calls[0][0];
      const tx = {
        loan:          { update: jest.fn().mockResolvedValue({}) },
        loanStatusLog: { create: jest.fn().mockResolvedValue({}) },
      };
      await tx_fn(tx);
      expect(tx.loan.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ collateral_received_at: now }) }),
      );
    });
  });
});
