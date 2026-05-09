import Decimal from 'decimal.js';
import { Test, TestingModule } from '@nestjs/testing';
import { mock, MockProxy } from 'jest-mock-extended';
import {
  DisbursementAccountKind,
  DisbursementAccountStatus,
  LoanStatus,
  PaymentRequestStatus,
} from '@prisma/client';
import type { User } from '@prisma/client';
import { LoansService } from '@/modules/loans/loans.service';
import { LoanStatusService } from '@/modules/loans/loan-status.service';
import { CalculatorService } from '@/modules/loans/calculator.service';
import { AccrualService } from '@/modules/loans/accrual.service';
import { PriceFeedService } from '@/modules/price-feed/price-feed.service';
import { PaymentRequestsService } from '@/modules/payment-requests/payment-requests.service';
import { UserRepaymentAccountsService } from '@/modules/user-repayment-accounts/user-repayment-accounts.service';
import { LoanNotificationsService } from '@/modules/loan-notifications/loan-notifications.service';
import { CollateralReleaseService } from '@/modules/loans/collateral-release.service';
import { AuthService } from '@/modules/auth/auth.service';
import { StepUpService } from '@/modules/auth/step-up.service';
import { PRICE_QUOTE_PROVIDER, type PriceQuoteProvider } from '@/modules/loans/price-quote.provider.interface';
import {
  COLLATERAL_PROVIDER,
  type CollateralProvider,
} from '@/modules/payment-requests/collateral.provider.interface';
import { PrismaService } from '@/database/prisma.service';
import { REDIS_CLIENT } from '@/database/redis.module';
import {
  AddCollateralAlreadyPendingException,
  CollateralAlreadyReleasedException,
  CollateralInvoiceFailedException,
  DisbursementDisabledException,
  InflowAlreadyMatchedException,
  InflowBelowFloorException,
  InflowNotFoundException,
  LoanDisabledException,
  LoanDisbursementAccountRequiredException,
  LoanInvalidTransitionException,
  LoanNotActiveException,
  LoanNotFoundException,
  NoUnmatchedInflowException,
  ReleaseAddressNotYetSetException,
  ReleaseAddressOtpRequiredException,
  RepaymentAccountNotReadyException,
  TransactionFactorNotSetException,
  TransactionFactorRequiredException,
} from '@/common/errors/bitmonie.errors';

const USER_ID   = 'user-uuid-001';
const LOAN_ID   = 'loan-uuid-001';
const ACCT_ID   = 'acct-uuid-001';

const ACTIVE_USER: User = {
  id:                              USER_ID,
  email:                           'ada@test.com',
  email_verified:                  true,
  totp_secret:                     null,
  totp_enabled:                    false,
  transaction_pin_hash:            null,
  transaction_pin_set_at:          null,
  transaction_pin_failed_attempts: 0,
  transaction_pin_locked_until:    null,
  country:                         'NG',
  is_active:                       true,
  disbursement_enabled:            true,
  loan_enabled:                    true,
  kyc_tier:                        1,
  first_name:                      'Ada',
  middle_name:                     null,
  last_name:                       'Obi',
  date_of_birth:                   null,
  created_at:                      new Date(),
  updated_at:                      new Date(),
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
  collateral_asset:         'SAT',
  collateral_amount_sat:    BigInt(515464),
  collateral_received_at:   null,
  disbursement_id:          null,
  principal_ngn:            new Decimal('300000'),
  origination_fee_ngn:      new Decimal('1500'),
  daily_interest_rate_bps:  30,
  daily_custody_fee_ngn:    new Decimal('300'),
  initial_collateral_usd:   new Decimal('250'),
  sat_ngn_rate_at_creation: new Decimal('0.97'),
  ltv_percent:              new Decimal('0.60'),
  collateral_release_address:   null,
  collateral_released_at:       null,
  collateral_release_reference: null,
  repayments:               [],
  status_logs:              [],
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
      count:             jest.fn().mockResolvedValue(0),
      create:            jest.fn().mockResolvedValue(DB_LOAN),
      findFirst:         jest.fn().mockResolvedValue(DB_LOAN),
      findUniqueOrThrow: jest.fn().mockResolvedValue(DB_LOAN),
      update:            jest.fn().mockResolvedValue(DB_LOAN),
      findMany:          jest.fn().mockResolvedValue([]),
    },
    loanRepayment: {
      create: jest.fn().mockResolvedValue({}),
    },
    collateralTopUp: {
      create: jest.fn().mockResolvedValue({ id: 'topup-uuid-001' }),
    },
    inflow: {
      update:    jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany:  jest.fn().mockResolvedValue([]),
    },
    paymentRequest: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    user: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ totp_enabled: false }),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ id: LOAN_ID }]),
    $transaction: jest.fn().mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          loan: {
            create:            jest.fn().mockResolvedValue(DB_LOAN),
            update:            jest.fn().mockResolvedValue({}),
            findUniqueOrThrow: jest.fn().mockResolvedValue(DB_LOAN),
          },
          loanRepayment: { create: jest.fn().mockResolvedValue({}) },
          loanStatusLog: { create: jest.fn().mockResolvedValue({}) },
          inflow:        { update: jest.fn().mockResolvedValue({}) },
          $queryRaw:     jest.fn().mockResolvedValue([{ id: LOAN_ID }]),
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
  let price_quote: MockProxy<PriceQuoteProvider>;
  let collateral_provider: MockProxy<CollateralProvider>;
  let user_repayment_accounts: MockProxy<UserRepaymentAccountsService>;
  let loan_notifications: MockProxy<LoanNotificationsService>;
  let collateral_release: MockProxy<CollateralReleaseService>;
  let auth_service: MockProxy<AuthService>;
  let step_up: MockProxy<StepUpService>;
  let redis: { set: jest.Mock; get: jest.Mock; del: jest.Mock };

  const SAT_RATE     = new Decimal('0.97');
  const BTC_USD_RATE = new Decimal('65000');

  const CHECKOUT_DTO = {
    principal_ngn:    300_000,
    terms_accepted:   true,
    principal_decimal: new Decimal('300000'),
  } as never;

  beforeEach(async () => {
    prisma = make_prisma();
    price_feed          = mock<PriceFeedService>();
    loan_status         = mock<LoanStatusService>();
    payment_requests    = mock<PaymentRequestsService>();
    price_quote         = mock<PriceQuoteProvider>();
    collateral_provider = mock<CollateralProvider>();
    user_repayment_accounts = mock<UserRepaymentAccountsService>();
    loan_notifications  = mock<LoanNotificationsService>();
    collateral_release  = mock<CollateralReleaseService>();
    collateral_release.releaseForLoan.mockResolvedValue({ status: 'released', reference: 'stub' });
    auth_service        = mock<AuthService>();
    step_up             = mock<StepUpService>();
    redis               = { set: jest.fn().mockResolvedValue('OK'), get: jest.fn(), del: jest.fn() };

    user_repayment_accounts.ensureForUser.mockResolvedValue({
      summary: {
        virtual_account_no:   '9012345678',
        virtual_account_name: 'Ada Obi',
        bank_name:            'PalmPay',
        provider:             'palmpay',
      },
      created: false,
    });

    price_feed.getCurrentRate.mockResolvedValue({ rate_buy: SAT_RATE, rate_sell: SAT_RATE });
    price_quote.getBtcUsdRate.mockResolvedValue(BTC_USD_RATE);
    payment_requests.create.mockResolvedValue(DB_PAYMENT_REQUEST);
    collateral_provider.createNoAmountInvoice.mockResolvedValue({
      provider_reference: 'stub_topup_hash_001',
      payment_request:    'lnbcrt_noamount_stub',
      receiving_address:  'stub_topup_hash_001',
      expires_at:         new Date(Date.now() + 1800_000),
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoansService,
        CalculatorService,
        AccrualService,
        { provide: PrismaService,          useValue: prisma },
        { provide: PriceFeedService,       useValue: price_feed },
        { provide: LoanStatusService,      useValue: loan_status },
        { provide: PaymentRequestsService, useValue: payment_requests },
        { provide: PRICE_QUOTE_PROVIDER,   useValue: price_quote },
        { provide: COLLATERAL_PROVIDER,    useValue: collateral_provider },
        { provide: REDIS_CLIENT,           useValue: redis },
        { provide: UserRepaymentAccountsService, useValue: user_repayment_accounts },
        { provide: LoanNotificationsService,     useValue: loan_notifications },
        { provide: CollateralReleaseService,     useValue: collateral_release },
        { provide: AuthService,                  useValue: auth_service },
        { provide: StepUpService,                useValue: step_up },
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

    it('throws PriceFeedStaleException when price feed is stale', async () => {
      const { PriceFeedStaleException } = await import('@/common/errors/bitmonie.errors');
      price_feed.getCurrentRate.mockRejectedValue(new PriceFeedStaleException({ last_updated_ms: 200_000 }));
      await expect(service.checkoutLoan(ACTIVE_USER, CHECKOUT_DTO)).rejects.toThrow(
        PriceFeedStaleException,
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
        origination_fee_ngn:     expect.any(String),
        daily_custody_fee_ngn:   expect.any(String),
        daily_interest_rate_bps: 30,
        daily_interest_ngn:      expect.any(String),
        daily_total_ngn:         expect.any(String),
        amount_to_receive_ngn:   expect.any(String),
      });
      // Disclosure: origination currently waived → customer receives full principal.
      expect(result.fee_breakdown.amount_to_receive_ngn).toBe('300000');
    });

    it('stamps terms_accepted_at on loan.create — proves consumer-protection consent', async () => {
      await service.checkoutLoan(ACTIVE_USER, CHECKOUT_DTO);

      const tx_fn = prisma.$transaction.mock.calls[0][0];
      const tx = {
        loan:          { create: jest.fn().mockResolvedValue(DB_LOAN), update: jest.fn() },
        loanStatusLog: { create: jest.fn().mockResolvedValue({}) },
      };
      await tx_fn(tx);
      const { data } = tx.loan.create.mock.calls[0][0];
      expect(data.terms_accepted_at).toBeInstanceOf(Date);
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
      // At rate 1.00, collateral_sat = ceil(300000 / 0.60 / 1.00) = 500000
      expect(data.collateral_amount_sat).toBe(BigInt(500000));
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

    it('returns payment_request for PENDING_COLLATERAL so the loan-detail page can render the BOLT11', async () => {
      prisma.loan.findFirst.mockResolvedValue({ ...(DB_LOAN as object), status_logs: [] } as never);
      prisma.paymentRequest.findFirst.mockResolvedValue({
        payment_request:   'lnbc1500u1...',
        receiving_address: 'jeremy@blink.sv',
        expires_at:        new Date('2026-05-05T14:32:00Z'),
      } as never);

      const result = await service.getLoan(USER_ID, LOAN_ID);

      expect(result.payment_request).toEqual({
        bolt11:            'lnbc1500u1...',
        payment_uri:       'lightning:lnbc1500u1...',
        receiving_address: 'jeremy@blink.sv',
        expires_at:        new Date('2026-05-05T14:32:00Z'),
        // BigInt → string per the JSON serialization shim in main.ts
        amount_sat:        '515464',
      });
    });

    it('returns payment_request=null for non-PENDING_COLLATERAL loans (no payment_request lookup)', async () => {
      prisma.loan.findFirst.mockResolvedValue({
        ...(DB_LOAN as object),
        status: LoanStatus.ACTIVE,
        status_logs: [],
      } as never);

      const result = await service.getLoan(USER_ID, LOAN_ID);

      expect(result.payment_request).toBeNull();
      expect(prisma.paymentRequest.findFirst).not.toHaveBeenCalled();
    });
  });

  // ── getRepaymentInstructions ──────────────────────────────────────────────────

  describe('getRepaymentInstructions', () => {
    const ACTIVE_LOAN = {
      ...(DB_LOAN as object),
      status:                 LoanStatus.ACTIVE,
      // 1 hour ago — unambiguously day 1 (ceilDays rounds anything in (0, 24h] up to 1).
      collateral_received_at: new Date(Date.now() - 60 * 60 * 1000),
      repayments:             [],
    } as never;

    it('throws LoanNotFoundException when loan does not belong to user', async () => {
      prisma.loan.findFirst.mockResolvedValue(null);
      await expect(service.getRepaymentInstructions(USER_ID, LOAN_ID))
        .rejects.toThrow(LoanNotFoundException);
    });

    it('throws LoanNotActiveException when loan is not ACTIVE', async () => {
      prisma.loan.findFirst.mockResolvedValue({
        ...(DB_LOAN as object),
        status: LoanStatus.PENDING_COLLATERAL,
        repayments: [],
      } as never);
      await expect(service.getRepaymentInstructions(USER_ID, LOAN_ID))
        .rejects.toThrow(LoanNotActiveException);
    });

    it('throws RepaymentAccountNotReadyException when ensureForUser returns null', async () => {
      prisma.loan.findFirst.mockResolvedValue(ACTIVE_LOAN);
      user_repayment_accounts.ensureForUser.mockResolvedValueOnce(null);
      await expect(service.getRepaymentInstructions(USER_ID, LOAN_ID))
        .rejects.toThrow(RepaymentAccountNotReadyException);
    });

    it('returns VA, outstanding, and minimum partial repayment floor', async () => {
      prisma.loan.findFirst.mockResolvedValue(ACTIVE_LOAN);
      const result = await service.getRepaymentInstructions(USER_ID, LOAN_ID);

      expect(result.loan_id).toBe(LOAN_ID);
      expect(result.repayment_account).toEqual({
        virtual_account_no:   '9012345678',
        virtual_account_name: 'Ada Obi',
        bank_name:            'PalmPay',
        provider:             'palmpay',
      });
      expect(result.minimum_partial_repayment_ngn).toBe('10000');
      // Outstanding shape — values come from AccrualService (real, not mocked).
      expect(result.outstanding).toEqual(expect.objectContaining({
        principal_ngn:         expect.any(String),
        accrued_interest_ngn:  expect.any(String),
        accrued_custody_ngn:   expect.any(String),
        total_outstanding_ngn: expect.any(String),
        days_elapsed:          expect.any(Number),
      }));
      // Day-1 of a N300k principal at 30 bps → N900 interest, plus N300/day custody.
      // Customer-facing strings are whole-naira (kobo internally; ceil at display).
      expect(result.outstanding.principal_ngn).toBe('300000');
      expect(result.outstanding.accrued_interest_ngn).toBe('900');
      expect(result.outstanding.accrued_custody_ngn).toBe('300');
      expect(result.outstanding.total_outstanding_ngn).toBe('301200');
      expect(result.outstanding.days_elapsed).toBe(1);
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

    it('refuses to change the address once collateral has been released', async () => {
      prisma.loan.findFirst.mockResolvedValue({
        ...(DB_LOAN as Record<string, unknown>),
        status:                       LoanStatus.REPAID,
        collateral_released_at:       new Date('2026-01-01T00:00:00Z'),
        collateral_release_reference: 'blink:ln_address:old@addr:42:0',
      } as never);

      await expect(
        service.setReleaseAddress(USER_ID, LOAN_ID, 'new@addr.sv'),
      ).rejects.toThrow(CollateralAlreadyReleasedException);

      expect(prisma.loan.update).not.toHaveBeenCalled();
    });

    it('clears the release-alert dedupe key when address is set on a REPAID loan with NULL released_at + NULL prior address', async () => {
      prisma.loan.findFirst.mockResolvedValue({
        ...(DB_LOAN as Record<string, unknown>),
        status:                       LoanStatus.REPAID,
        collateral_released_at:       null,
        collateral_release_address:   null,    // first-set-only — must be NULL to set
      } as never);

      await service.setReleaseAddress(USER_ID, LOAN_ID, 'new@addr.sv');

      expect(redis.del).toHaveBeenCalledWith(
        expect.stringContaining(`collateral_release:alerted:${LOAN_ID}`),
      );
    });

    it('change without any factor configured is rejected (TRANSACTION_FACTOR_NOT_SET)', async () => {
      prisma.loan.findFirst.mockResolvedValue({
        ...(DB_LOAN as Record<string, unknown>),
        status:                     LoanStatus.ACTIVE,
        collateral_release_address: 'old@addr.sv',
        collateral_released_at:     null,
      } as never);
      step_up.assertHasAnyFactorConfigured.mockRejectedValue(new TransactionFactorNotSetException());

      await expect(
        service.setReleaseAddress(USER_ID, LOAN_ID, 'new@addr.sv', {
          email_otp:       '482917',
          transaction_pin: '142857',
        }),
      ).rejects.toThrow(TransactionFactorNotSetException);

      // No OTP consumed — refused before the email check.
      expect(auth_service.consumeReleaseAddressChangeOtp).not.toHaveBeenCalled();
      expect(prisma.loan.update).not.toHaveBeenCalled();
    });

    it('change without an email_otp is rejected (RELEASE_ADDRESS_OTP_REQUIRED)', async () => {
      prisma.loan.findFirst.mockResolvedValue({
        ...(DB_LOAN as Record<string, unknown>),
        status:                     LoanStatus.ACTIVE,
        collateral_release_address: 'old@addr.sv',
        collateral_released_at:     null,
      } as never);

      await expect(
        service.setReleaseAddress(USER_ID, LOAN_ID, 'new@addr.sv'),
      ).rejects.toThrow(ReleaseAddressOtpRequiredException);

      expect(auth_service.consumeReleaseAddressChangeOtp).not.toHaveBeenCalled();
      expect(prisma.loan.update).not.toHaveBeenCalled();
    });

    it('change with email_otp + transaction_pin succeeds (PIN path)', async () => {
      prisma.loan.findFirst.mockResolvedValue({
        ...(DB_LOAN as Record<string, unknown>),
        status:                     LoanStatus.ACTIVE,
        collateral_release_address: 'old@addr.sv',
        collateral_released_at:     null,
      } as never);

      await service.setReleaseAddress(USER_ID, LOAN_ID, 'new@addr.sv', {
        email_otp:       '482917',
        transaction_pin: '142857',
      });

      expect(auth_service.consumeReleaseAddressChangeOtp)
        .toHaveBeenCalledWith(USER_ID, LOAN_ID, '482917');
      expect(step_up.verifyTransactionFactor)
        .toHaveBeenCalledWith(USER_ID, { transaction_pin: '142857', totp_code: undefined });
      expect(prisma.loan.update).toHaveBeenCalledWith({
        where: { id: LOAN_ID },
        data:  { collateral_release_address: 'new@addr.sv' },
      });
    });

    it('change with email_otp + totp_code succeeds (TOTP path)', async () => {
      prisma.loan.findFirst.mockResolvedValue({
        ...(DB_LOAN as Record<string, unknown>),
        status:                     LoanStatus.ACTIVE,
        collateral_release_address: 'old@addr.sv',
        collateral_released_at:     null,
      } as never);

      await service.setReleaseAddress(USER_ID, LOAN_ID, 'new@addr.sv', {
        email_otp: '482917',
        totp_code: '293041',
      });

      expect(step_up.verifyTransactionFactor)
        .toHaveBeenCalledWith(USER_ID, { transaction_pin: undefined, totp_code: '293041' });
      expect(prisma.loan.update).toHaveBeenCalled();
    });

    it('change with email_otp but neither factor is rejected (TRANSACTION_FACTOR_REQUIRED)', async () => {
      prisma.loan.findFirst.mockResolvedValue({
        ...(DB_LOAN as Record<string, unknown>),
        status:                     LoanStatus.ACTIVE,
        collateral_release_address: 'old@addr.sv',
        collateral_released_at:     null,
      } as never);
      step_up.verifyTransactionFactor.mockRejectedValue(new TransactionFactorRequiredException());

      await expect(
        service.setReleaseAddress(USER_ID, LOAN_ID, 'new@addr.sv', { email_otp: '482917' }),
      ).rejects.toThrow(TransactionFactorRequiredException);

      // Email OTP is consumed BEFORE the factor check (single-use, already
      // burned by the wrong call). Loan is not updated.
      expect(auth_service.consumeReleaseAddressChangeOtp).toHaveBeenCalled();
      expect(prisma.loan.update).not.toHaveBeenCalled();
    });

    it('first-set (NULL → value) does NOT require email_otp or any factor', async () => {
      prisma.loan.findFirst.mockResolvedValue({
        ...(DB_LOAN as Record<string, unknown>),
        status:                     LoanStatus.ACTIVE,
        collateral_release_address: null,
        collateral_released_at:     null,
      } as never);

      await service.setReleaseAddress(USER_ID, LOAN_ID, 'first@addr.sv');

      expect(auth_service.consumeReleaseAddressChangeOtp).not.toHaveBeenCalled();
      expect(step_up.verifyTransactionFactor).not.toHaveBeenCalled();
      expect(step_up.assertHasAnyFactorConfigured).not.toHaveBeenCalled();
      expect(prisma.loan.update).toHaveBeenCalledWith({
        where: { id: LOAN_ID },
        data:  { collateral_release_address: 'first@addr.sv' },
      });
    });

    it('post-release exception takes precedence over the OTP requirement (clearer customer-facing message)', async () => {
      prisma.loan.findFirst.mockResolvedValue({
        ...(DB_LOAN as Record<string, unknown>),
        status:                       LoanStatus.REPAID,
        collateral_release_address:   'ada@blink.sv',
        collateral_released_at:       new Date('2026-01-01T00:00:00Z'),
        collateral_release_reference: 'ref',
      } as never);

      await expect(
        service.setReleaseAddress(USER_ID, LOAN_ID, 'new@addr.sv', { email_otp: '482917' }),
      ).rejects.toThrow(CollateralAlreadyReleasedException);
      expect(auth_service.consumeReleaseAddressChangeOtp).not.toHaveBeenCalled();
    });

    it('does NOT clear dedupe key when loan is not REPAID (no-op for ACTIVE / PENDING)', async () => {
      prisma.loan.findFirst.mockResolvedValue({
        ...(DB_LOAN as Record<string, unknown>),
        status: LoanStatus.ACTIVE,
      } as never);

      await service.setReleaseAddress(USER_ID, LOAN_ID, 'addr');

      expect(redis.del).not.toHaveBeenCalled();
    });
  });

  // ── requestReleaseAddressChangeOtp ──────────────────────────────────────────

  describe('requestReleaseAddressChangeOtp', () => {
    it('throws LoanNotFoundException for an unknown loan', async () => {
      prisma.loan.findFirst.mockResolvedValue(null);
      await expect(service.requestReleaseAddressChangeOtp(USER_ID, LOAN_ID))
        .rejects.toThrow(LoanNotFoundException);
    });

    it('throws CollateralAlreadyReleasedException after release', async () => {
      prisma.loan.findFirst.mockResolvedValue({
        ...(DB_LOAN as Record<string, unknown>),
        collateral_release_address:   'ada@blink.sv',
        collateral_released_at:       new Date(),
        collateral_release_reference: 'ref',
      } as never);
      await expect(service.requestReleaseAddressChangeOtp(USER_ID, LOAN_ID))
        .rejects.toThrow(CollateralAlreadyReleasedException);
      expect(auth_service.sendReleaseAddressChangeOtp).not.toHaveBeenCalled();
    });

    it('throws ReleaseAddressNotYetSetException when no existing address (first-set is exempt)', async () => {
      prisma.loan.findFirst.mockResolvedValue({
        ...(DB_LOAN as Record<string, unknown>),
        collateral_release_address: null,
      } as never);
      await expect(service.requestReleaseAddressChangeOtp(USER_ID, LOAN_ID))
        .rejects.toThrow(ReleaseAddressNotYetSetException);
      expect(auth_service.sendReleaseAddressChangeOtp).not.toHaveBeenCalled();
    });

    it('delegates to AuthService.sendReleaseAddressChangeOtp on the happy path', async () => {
      prisma.loan.findFirst.mockResolvedValue({
        ...(DB_LOAN as Record<string, unknown>),
        collateral_release_address: 'ada@blink.sv',
        collateral_released_at:     null,
      } as never);
      await service.requestReleaseAddressChangeOtp(USER_ID, LOAN_ID);
      expect(auth_service.sendReleaseAddressChangeOtp).toHaveBeenCalledWith(USER_ID, LOAN_ID);
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

  // ── creditInflow ──────────────────────────────────────────────────────────────

  describe('creditInflow', () => {
    const INFLOW_ID = 'inflow-uuid-001';

    // Helper: build a loan in a given status, with given collateral_received_at.
    function makeActiveLoan(opts: {
      status?: LoanStatus;
      collateral_received_at?: Date | null;
      principal_ngn?: Decimal;
      daily_custody_fee_ngn?: Decimal;
    } = {}) {
      const base = DB_LOAN as Record<string, unknown>;
      return {
        ...base,
        status:                  opts.status                ?? LoanStatus.ACTIVE,
        collateral_received_at:  opts.collateral_received_at ?? new Date(Date.now() - 29.5 * 86400_000),
        principal_ngn:           opts.principal_ngn         ?? new Decimal('500000'),
        daily_interest_rate_bps: 30,
        daily_custody_fee_ngn:   opts.daily_custody_fee_ngn ?? new Decimal('700'),
        repayments:              [],
      };
    }

    function setupTx(loan_in_tx: object) {
      // The transaction body uses tx.loan.findUniqueOrThrow + tx.loanRepayment.create + tx.inflow.update.
      const tx_loan_create        = jest.fn().mockResolvedValue(loan_in_tx);
      const tx_loan_update        = jest.fn().mockResolvedValue({});
      const tx_loan_findUnique    = jest.fn().mockResolvedValue(loan_in_tx);
      const tx_repayment_create   = jest.fn().mockResolvedValue({});
      const tx_inflow_update      = jest.fn().mockResolvedValue({});
      const tx_status_log_create  = jest.fn().mockResolvedValue({});
      const tx_query_raw          = jest.fn().mockResolvedValue([{ id: LOAN_ID }]);

      prisma.$transaction.mockImplementationOnce(
        async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            loan:          { create: tx_loan_create, update: tx_loan_update, findUniqueOrThrow: tx_loan_findUnique },
            loanRepayment: { create: tx_repayment_create },
            inflow:        { update: tx_inflow_update },
            loanStatusLog: { create: tx_status_log_create },
            $queryRaw:     tx_query_raw,
          }),
      );

      return { tx_loan_update, tx_repayment_create, tx_inflow_update };
    }

    it('rejects amounts below the partial-repayment floor (N10,000)', async () => {
      await expect(
        service.creditInflow({
          inflow_id:    INFLOW_ID,
          loan_id:      LOAN_ID,
          amount_ngn:   new Decimal('5000'),
          match_method: 'AUTO_AMOUNT',
        }),
      ).rejects.toThrow(InflowBelowFloorException);
    });

    it('credits a partial repayment to an ACTIVE loan and stays ACTIVE', async () => {
      // Loan: 500k principal, day 30, custody 700/day → outstanding ≈ 566k
      setupTx(makeActiveLoan());

      const result = await service.creditInflow({
        inflow_id:    INFLOW_ID,
        loan_id:      LOAN_ID,
        amount_ngn:   new Decimal('100000'),
        match_method: 'AUTO_AMOUNT',
      });

      expect(result.new_status).toBe(LoanStatus.ACTIVE);
      // Waterfall on N100k against custody 21k + interest 45k + principal 500k:
      // → custody 21,000 / interest 45,000 / principal 34,000 / overpay 0
      expect(result.applied_to_custody).toBe('21000');
      expect(result.applied_to_interest).toBe('45000');
      expect(result.applied_to_principal).toBe('34000');
      expect(result.overpay_ngn).toBe('0');

      expect(loan_status.transition).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          to_status:    LoanStatus.ACTIVE,
          reason_code:  'REPAYMENT_PARTIAL_NGN',
        }),
      );
    });

    it('full repayment closes the loan to REPAID', async () => {
      setupTx(makeActiveLoan());

      const result = await service.creditInflow({
        inflow_id:    INFLOW_ID,
        loan_id:      LOAN_ID,
        amount_ngn:   new Decimal('566000'),
        match_method: 'CUSTOMER_CLAIM',
      });

      expect(result.new_status).toBe(LoanStatus.REPAID);
      expect(result.applied_to_principal).toBe('500000');
      expect(result.overpay_ngn).toBe('0');

      expect(loan_status.transition).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          to_status:   LoanStatus.REPAID,
          reason_code: 'REPAYMENT_COMPLETED',
        }),
      );
    });

    it('triggers post-commit collateral release when full repayment closes the loan', async () => {
      setupTx(makeActiveLoan());

      await service.creditInflow({
        inflow_id:    INFLOW_ID,
        loan_id:      LOAN_ID,
        amount_ngn:   new Decimal('566000'),
        match_method: 'CUSTOMER_CLAIM',
      });

      // Fire-and-forget — the service may resolve before the release call
      // settles, so flush microtasks before asserting.
      await Promise.resolve();
      expect(collateral_release.releaseForLoan).toHaveBeenCalledWith(LOAN_ID);
    });

    it('does NOT trigger collateral release on a partial repayment', async () => {
      setupTx(makeActiveLoan());

      await service.creditInflow({
        inflow_id:    INFLOW_ID,
        loan_id:      LOAN_ID,
        amount_ngn:   new Decimal('100000'),
        match_method: 'AUTO_AMOUNT',
      });

      await Promise.resolve();
      expect(collateral_release.releaseForLoan).not.toHaveBeenCalled();
    });

    it('overpayment closes the loan and records overpay_ngn', async () => {
      setupTx(makeActiveLoan());

      const result = await service.creditInflow({
        inflow_id:    INFLOW_ID,
        loan_id:      LOAN_ID,
        amount_ngn:   new Decimal('600000'),
        match_method: 'AUTO_AMOUNT',
      });

      expect(result.new_status).toBe(LoanStatus.REPAID);
      expect(result.overpay_ngn).toBe('34000');
    });

    it('inserts a LoanRepayment row in the same transaction', async () => {
      const handles = setupTx(makeActiveLoan());

      await service.creditInflow({
        inflow_id:    INFLOW_ID,
        loan_id:      LOAN_ID,
        amount_ngn:   new Decimal('50000'),
        match_method: 'AUTO_AMOUNT',
      });

      expect(handles.tx_repayment_create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            loan_id:      LOAN_ID,
            inflow_id:    INFLOW_ID,
            match_method: 'AUTO_AMOUNT',
          }),
        }),
      );
    });

    it('marks the Inflow matched in the same transaction', async () => {
      const handles = setupTx(makeActiveLoan());

      await service.creditInflow({
        inflow_id:    INFLOW_ID,
        loan_id:      LOAN_ID,
        amount_ngn:   new Decimal('50000'),
        match_method: 'AUTO_AMOUNT',
      });

      expect(handles.tx_inflow_update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: INFLOW_ID },
          data:  expect.objectContaining({
            is_matched:  true,
            source_type: 'LOAN_REPAYMENT',
            source_id:   LOAN_ID,
          }),
        }),
      );
    });

    it('is idempotent against an already-REPAID loan (no-op return)', async () => {
      setupTx({ ...makeActiveLoan(), status: LoanStatus.REPAID });

      const result = await service.creditInflow({
        inflow_id:    INFLOW_ID,
        loan_id:      LOAN_ID,
        amount_ngn:   new Decimal('50000'),
        match_method: 'AUTO_AMOUNT',
      });

      expect(result.new_status).toBe(LoanStatus.REPAID);
      expect(result.applied_to_principal).toBe('0');
      expect(loan_status.transition).not.toHaveBeenCalled();
    });

    it('rejects credits to non-ACTIVE non-REPAID loans (LIQUIDATED, EXPIRED, etc.)', async () => {
      setupTx({ ...makeActiveLoan(), status: LoanStatus.LIQUIDATED });

      await expect(
        service.creditInflow({
          inflow_id:    INFLOW_ID,
          loan_id:      LOAN_ID,
          amount_ngn:   new Decimal('50000'),
          match_method: 'AUTO_AMOUNT',
        }),
      ).rejects.toThrow(LoanNotActiveException);
    });

    it('throws LoanNotFoundException when the loan FOR UPDATE lock returns no rows', async () => {
      prisma.$transaction.mockImplementationOnce(
        async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            loan:          { findUniqueOrThrow: jest.fn() },
            loanRepayment: { create: jest.fn() },
            inflow:        { update: jest.fn() },
            loanStatusLog: { create: jest.fn() },
            $queryRaw:     jest.fn().mockResolvedValue([]),
          }),
      );

      await expect(
        service.creditInflow({
          inflow_id:    INFLOW_ID,
          loan_id:      LOAN_ID,
          amount_ngn:   new Decimal('50000'),
          match_method: 'AUTO_AMOUNT',
        }),
      ).rejects.toThrow(LoanNotFoundException);
    });
  });

  // ── createCollateralTopUp ─────────────────────────────────────────────────────

  describe('createCollateralTopUp', () => {
    function activeLoan() {
      const base = DB_LOAN as Record<string, unknown>;
      return { ...base, status: LoanStatus.ACTIVE };
    }

    it('throws LoanNotFoundException when loan does not belong to user', async () => {
      prisma.loan.findFirst.mockResolvedValue(null);
      await expect(service.createCollateralTopUp(USER_ID, LOAN_ID)).rejects.toThrow(LoanNotFoundException);
    });

    it('throws LoanNotActiveException when loan is not ACTIVE', async () => {
      prisma.loan.findFirst.mockResolvedValue({ ...(DB_LOAN as Record<string, unknown>), status: LoanStatus.PENDING_COLLATERAL } as never);
      await expect(service.createCollateralTopUp(USER_ID, LOAN_ID)).rejects.toThrow(LoanNotActiveException);
    });

    it('translates Prisma unique-violation (P2002) to AddCollateralAlreadyPendingException', async () => {
      prisma.loan.findFirst.mockResolvedValue(activeLoan() as never);
      prisma.collateralTopUp.create.mockRejectedValue({ code: 'P2002', message: 'Unique constraint' });

      await expect(service.createCollateralTopUp(USER_ID, LOAN_ID)).rejects.toThrow(
        AddCollateralAlreadyPendingException,
      );
    });

    it('throws CollateralInvoiceFailedException when provider invoice creation fails', async () => {
      prisma.loan.findFirst.mockResolvedValue(activeLoan() as never);
      collateral_provider.createNoAmountInvoice.mockRejectedValue(new Error('Blink down'));

      await expect(service.createCollateralTopUp(USER_ID, LOAN_ID)).rejects.toThrow(
        CollateralInvoiceFailedException,
      );
    });

    it('happy path: returns invoice details and sets Redis cache key', async () => {
      prisma.loan.findFirst.mockResolvedValue(activeLoan() as never);

      const result = await service.createCollateralTopUp(USER_ID, LOAN_ID);

      expect(result.topup_id).toBe('topup-uuid-001');
      expect(result.payment_request).toBe('lnbcrt_noamount_stub');
      expect(result.receiving_address).toBe('stub_topup_hash_001');
      expect(result.expires_at).toBeInstanceOf(Date);

      expect(prisma.collateralTopUp.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            loan_id:                 LOAN_ID,
            collateral_provider:     'blink',
            collateral_provider_ref: 'stub_topup_hash_001',
            status:                  'PENDING_COLLATERAL',
          }),
        } as never),
      );

      expect(redis.set).toHaveBeenCalledWith(
        'collateral_topup:pending:stub_topup_hash_001',
        'topup-uuid-001',
        'EX',
        expect.any(Number),
      );
    });
  });

  // ── claimInflow ───────────────────────────────────────────────────────────────

  describe('claimInflow', () => {
    function activeLoan() {
      const base = DB_LOAN as Record<string, unknown>;
      return {
        ...base,
        status:                 LoanStatus.ACTIVE,
        collateral_received_at: new Date(Date.now() - 29.5 * 86400_000),
        principal_ngn:          new Decimal('500000'),
        daily_custody_fee_ngn:  new Decimal('700'),
        repayments:             [],
      };
    }

    it('throws LoanNotFoundException when loan does not belong to user', async () => {
      prisma.loan.findFirst.mockResolvedValue(null);
      await expect(service.claimInflow(USER_ID, LOAN_ID)).rejects.toThrow(LoanNotFoundException);
    });

    it('throws LoanNotActiveException when loan is not ACTIVE', async () => {
      prisma.loan.findFirst.mockResolvedValue({ ...(DB_LOAN as Record<string, unknown>), status: LoanStatus.LIQUIDATED } as never);
      await expect(service.claimInflow(USER_ID, LOAN_ID)).rejects.toThrow(LoanNotActiveException);
    });

    it('throws NoUnmatchedInflowException when no candidate inflow is found', async () => {
      prisma.loan.findFirst.mockResolvedValue(activeLoan() as never);
      prisma.inflow.findFirst.mockResolvedValue(null);
      await expect(service.claimInflow(USER_ID, LOAN_ID)).rejects.toThrow(NoUnmatchedInflowException);
    });

    it('queries inflows scoped to user, unmatched, NGN, within 24h, above floor', async () => {
      prisma.loan.findFirst.mockResolvedValue(activeLoan() as never);
      prisma.inflow.findFirst.mockResolvedValue({
        id:         'inflow-claim-001',
        amount:     new Decimal('50000'),
        user_id:    USER_ID,
        currency:   'NGN',
        is_matched: false,
        source_type: null,
        created_at: new Date(),
      } as never);

      // For credit transaction inside creditInflow, use the default $transaction mock.
      // Suppress the actual credit logic — just verify the candidate search params.

      try { await service.claimInflow(USER_ID, LOAN_ID); } catch { /* credit path isn't under test here */ }

      expect(prisma.inflow.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            user_id:     USER_ID,
            is_matched:  false,
            source_type: null,
            currency:    'NGN',
            created_at:  { gte: expect.any(Date) },
            amount:      { gte: '10000.00' },
          }),
          orderBy: { created_at: 'desc' },
        } as never),
      );
    });

    it('credits the matched inflow with match_method=CUSTOMER_CLAIM', async () => {
      prisma.loan.findFirst.mockResolvedValue(activeLoan() as never);
      prisma.inflow.findFirst.mockResolvedValue({
        id:          'inflow-claim-001',
        amount:      new Decimal('50000'),
        user_id:     USER_ID,
        currency:    'NGN',
        is_matched:  false,
        source_type: null,
        created_at:  new Date(),
      } as never);

      // Make the inner $transaction return a stable shape so we can assert the match_method.
      let captured_match_method: string | undefined;
      prisma.$transaction.mockImplementationOnce(
        async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            loan: {
              findUniqueOrThrow: jest.fn().mockResolvedValue(activeLoan()),
              update:            jest.fn().mockResolvedValue({}),
            },
            loanRepayment: {
              create: jest.fn().mockImplementation((args: { data: { match_method: string } }) => {
                captured_match_method = args.data.match_method;
                return Promise.resolve({});
              }),
            },
            inflow:        { update: jest.fn().mockResolvedValue({}) },
            loanStatusLog: { create: jest.fn().mockResolvedValue({}) },
            $queryRaw:     jest.fn().mockResolvedValue([{ id: LOAN_ID }]),
          }),
      );

      await service.claimInflow(USER_ID, LOAN_ID);

      expect(captured_match_method).toBe('CUSTOMER_CLAIM');
    });
  });

  // ── findActiveLoanMatchingOutstanding ──────────────────────────────────────

  describe('findActiveLoanMatchingOutstanding', () => {
    function loanWithPrincipal(id: string, principal: string, days_ago: number) {
      const collateral_received_at = new Date(Date.now() - days_ago * 86400_000);
      return {
        ...(DB_LOAN as Record<string, unknown>),
        id,
        status:                 LoanStatus.ACTIVE,
        principal_ngn:          new Decimal(principal),
        origination_fee_ngn:    new Decimal('0'),
        daily_custody_fee_ngn:  new Decimal('0'),  // simplify: only principal + interest contribute
        daily_interest_rate_bps: 0,                 // outstanding == principal exactly
        collateral_received_at,
        repayments:             [],
        created_at:             collateral_received_at,
      };
    }

    it('returns null when user has no ACTIVE loans', async () => {
      prisma.loan.findMany.mockResolvedValue([]);
      const result = await service.findActiveLoanMatchingOutstanding(USER_ID, new Decimal('50000'));
      expect(result).toBeNull();
    });

    it('returns null when no loan outstanding matches the amount', async () => {
      prisma.loan.findMany.mockResolvedValue([
        loanWithPrincipal('loan-A', '100000', 5),
        loanWithPrincipal('loan-B', '200000', 3),
      ] as never);
      const result = await service.findActiveLoanMatchingOutstanding(USER_ID, new Decimal('50000'));
      expect(result).toBeNull();
    });

    it('returns the unique loan when exactly one outstanding matches', async () => {
      prisma.loan.findMany.mockResolvedValue([
        loanWithPrincipal('loan-A', '100000', 5),
        loanWithPrincipal('loan-B', '50000',  3),
      ] as never);
      const result = await service.findActiveLoanMatchingOutstanding(USER_ID, new Decimal('50000'));
      expect(result).toEqual({ loan_id: 'loan-B', tiebreaker: 'unique' });
    });

    it('returns the oldest loan when multiple outstandings match (created_at tiebreaker)', async () => {
      prisma.loan.findMany.mockResolvedValue([
        loanWithPrincipal('loan-A-older',  '50000', 10),
        loanWithPrincipal('loan-B-newer',  '50000', 1),
      ] as never);
      const result = await service.findActiveLoanMatchingOutstanding(USER_ID, new Decimal('50000'));
      expect(result).toEqual({ loan_id: 'loan-A-older', tiebreaker: 'oldest' });
    });

    it('absorbs sub-naira accrual fractions within ₦0.50 tolerance', async () => {
      // Outstanding will compute to 50000.40; inflow is 50000.00 — within 0.50 tolerance.
      const loan = loanWithPrincipal('loan-A', '50000.40', 1);
      prisma.loan.findMany.mockResolvedValue([loan] as never);
      const result = await service.findActiveLoanMatchingOutstanding(USER_ID, new Decimal('50000'));
      expect(result).toEqual({ loan_id: 'loan-A', tiebreaker: 'unique' });
    });

    it('rejects matches outside ₦0.50 tolerance', async () => {
      const loan = loanWithPrincipal('loan-A', '50001', 1);
      prisma.loan.findMany.mockResolvedValue([loan] as never);
      const result = await service.findActiveLoanMatchingOutstanding(USER_ID, new Decimal('50000'));
      expect(result).toBeNull();
    });
  });

  // ── applyInflowToLoan ──────────────────────────────────────────────────────

  describe('applyInflowToLoan', () => {
    const INFLOW_ID = 'inflow-uuid-001';
    function activeLoan() {
      return {
        ...(DB_LOAN as Record<string, unknown>),
        status:                 LoanStatus.ACTIVE,
        collateral_received_at: new Date(Date.now() - 5 * 86400_000),
        repayments:             [],
      };
    }
    function unmatchedInflow(overrides: Record<string, unknown> = {}) {
      return {
        id:                 INFLOW_ID,
        user_id:            USER_ID,
        currency:           'NGN',
        amount:             new Decimal('50000'),
        is_matched:         false,
        matched_at:         null,
        source_type:        null,
        source_id:          null,
        provider_response:  null,
        ...overrides,
      };
    }

    it('throws LoanNotFoundException when loan does not belong to user', async () => {
      prisma.loan.findFirst.mockResolvedValue(null);
      await expect(service.applyInflowToLoan(USER_ID, INFLOW_ID, LOAN_ID))
        .rejects.toThrow(LoanNotFoundException);
    });

    it('throws LoanNotActiveException when loan is not ACTIVE', async () => {
      prisma.loan.findFirst.mockResolvedValue({
        ...(DB_LOAN as Record<string, unknown>),
        status: LoanStatus.LIQUIDATED,
      } as never);
      await expect(service.applyInflowToLoan(USER_ID, INFLOW_ID, LOAN_ID))
        .rejects.toThrow(LoanNotActiveException);
    });

    it('throws InflowNotFoundException when inflow does not belong to user', async () => {
      prisma.loan.findFirst.mockResolvedValue(activeLoan() as never);
      prisma.inflow.findFirst.mockResolvedValue(null);
      await expect(service.applyInflowToLoan(USER_ID, INFLOW_ID, LOAN_ID))
        .rejects.toThrow(InflowNotFoundException);
    });

    it('throws InflowAlreadyMatchedException when inflow is_matched', async () => {
      prisma.loan.findFirst.mockResolvedValue(activeLoan() as never);
      prisma.inflow.findFirst.mockResolvedValue(unmatchedInflow({
        is_matched: true,
        matched_at: new Date(),
      }) as never);
      await expect(service.applyInflowToLoan(USER_ID, INFLOW_ID, LOAN_ID))
        .rejects.toThrow(InflowAlreadyMatchedException);
    });

    it('treats requery_mismatch inflow as untrusted (404)', async () => {
      prisma.loan.findFirst.mockResolvedValue(activeLoan() as never);
      prisma.inflow.findFirst.mockResolvedValue(unmatchedInflow({
        provider_response: { bitmonie_unmatched_reason: 'requery_mismatch' },
      }) as never);
      await expect(service.applyInflowToLoan(USER_ID, INFLOW_ID, LOAN_ID))
        .rejects.toThrow(InflowNotFoundException);
    });

    it('treats requery_unconfirmed inflow as untrusted (404)', async () => {
      prisma.loan.findFirst.mockResolvedValue(activeLoan() as never);
      prisma.inflow.findFirst.mockResolvedValue(unmatchedInflow({
        provider_response: { bitmonie_unmatched_reason: 'requery_unconfirmed' },
      }) as never);
      await expect(service.applyInflowToLoan(USER_ID, INFLOW_ID, LOAN_ID))
        .rejects.toThrow(InflowNotFoundException);
    });

    it('credits below-floor inflows on the explicit-claim path (skip_floor=true)', async () => {
      prisma.loan.findFirst.mockResolvedValue(activeLoan() as never);
      prisma.inflow.findFirst.mockResolvedValue(unmatchedInflow({
        amount: new Decimal('1000'),  // below MIN_PARTIAL_REPAYMENT_NGN
      }) as never);

      let captured_match_method: string | undefined;
      let captured_amount: string | undefined;
      prisma.$transaction.mockImplementationOnce(
        async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            loan: {
              findUniqueOrThrow: jest.fn().mockResolvedValue(activeLoan()),
              update:            jest.fn().mockResolvedValue({}),
            },
            loanRepayment: {
              create: jest.fn().mockImplementation((args: { data: { match_method: string; amount_ngn: { toFixed: () => string } } }) => {
                captured_match_method = args.data.match_method;
                captured_amount = args.data.amount_ngn.toFixed();
                return Promise.resolve({});
              }),
            },
            inflow:        { update: jest.fn().mockResolvedValue({}) },
            loanStatusLog: { create: jest.fn().mockResolvedValue({}) },
            $queryRaw:     jest.fn().mockResolvedValue([{ id: LOAN_ID }]),
          }),
      );

      await service.applyInflowToLoan(USER_ID, INFLOW_ID, LOAN_ID);

      expect(captured_match_method).toBe('CUSTOMER_CLAIM');
      expect(captured_amount).toBe('1000');  // floor was bypassed
    });
  });

  // ── listUnmatchedInflowsForUser ────────────────────────────────────────────

  describe('listUnmatchedInflowsForUser', () => {
    function rawInflow(overrides: Record<string, unknown>) {
      return {
        id:                 'inflow-1',
        user_id:            USER_ID,
        currency:           'NGN',
        amount:             new Decimal('50000'),
        is_matched:         false,
        source_type:        null,
        receiving_address:  '9012345678',
        provider_response:  { payerAccountName: 'Ada Obi', payerBankName: 'GTBank' },
        created_at:         new Date('2026-04-30T12:00:00Z'),
        ...overrides,
      };
    }

    it('returns CLAIMABLE for inflows above the floor', async () => {
      prisma.inflow.findMany = jest.fn().mockResolvedValue([rawInflow({ amount: new Decimal('50000') })]);
      const result = await service.listUnmatchedInflowsForUser(USER_ID);
      expect(result).toHaveLength(1);
      expect(result[0]!.status).toBe('CLAIMABLE');
      expect(result[0]!.amount_ngn).toBe('50000');
      expect(result[0]!.payer_name).toBe('Ada Obi');
      expect(result[0]!.payer_bank_name).toBe('GTBank');
      expect(result[0]!.received_via).toBe('9012345678');
    });

    it('returns BELOW_MINIMUM for inflows under N10,000', async () => {
      prisma.inflow.findMany = jest.fn().mockResolvedValue([rawInflow({ amount: new Decimal('1000') })]);
      const result = await service.listUnmatchedInflowsForUser(USER_ID);
      expect(result[0]!.status).toBe('BELOW_MINIMUM');
    });

    it('excludes untrusted inflows (requery_mismatch, requery_unconfirmed, credit_failed)', async () => {
      prisma.inflow.findMany = jest.fn().mockResolvedValue([
        rawInflow({ id: 'inf-trusted',     provider_response: {} }),
        rawInflow({ id: 'inf-mismatch',    provider_response: { bitmonie_unmatched_reason: 'requery_mismatch' } }),
        rawInflow({ id: 'inf-unconfirmed', provider_response: { bitmonie_unmatched_reason: 'requery_unconfirmed' } }),
        rawInflow({ id: 'inf-credit-fail', provider_response: { bitmonie_unmatched_reason: 'credit_failed' } }),
      ]);
      const result = await service.listUnmatchedInflowsForUser(USER_ID);
      expect(result.map((r) => r.id)).toEqual(['inf-trusted']);
    });

    it('queries scoped to user, NGN, unmatched, source_type=null, ordered by created_at desc', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      prisma.inflow.findMany = findMany;
      await service.listUnmatchedInflowsForUser(USER_ID);
      expect(findMany).toHaveBeenCalledWith({
        where:   { user_id: USER_ID, currency: 'NGN', is_matched: false, source_type: null },
        orderBy: { created_at: 'desc' },
      });
    });
  });
});
