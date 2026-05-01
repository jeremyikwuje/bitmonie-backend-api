import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DisbursementAccountKind,
  DisbursementAccountStatus,
  LoanStatus,
  RepaymentMethod,
  StatusTrigger,
  TopUpStatus,
} from '@prisma/client';
import Decimal from 'decimal.js';
import type { User } from '@prisma/client';
import { AssetPair } from '@prisma/client';
import type Redis from 'ioredis';
import { PrismaService } from '@/database/prisma.service';
import { REDIS_CLIENT } from '@/database/redis.module';
import { PriceFeedService } from '@/modules/price-feed/price-feed.service';
import { CalculatorService } from './calculator.service';
import { AccrualService, type AccrualRepaymentInput } from './accrual.service';
import { LoanStatusService } from './loan-status.service';
import { CollateralReleaseService } from './collateral-release.service';
import { PaymentRequestsService } from '@/modules/payment-requests/payment-requests.service';
import {
  COLLATERAL_PROVIDER,
  type CollateralProvider,
} from '@/modules/payment-requests/collateral.provider.interface';
import { PRICE_QUOTE_PROVIDER, type PriceQuoteProvider } from './price-quote.provider.interface';
import {
  COLLATERAL_TOPUP_EXPIRY_SEC,
  INFLOW_OUTSTANDING_MATCH_TOLERANCE_NGN,
  LoanReasonCodes,
  MIN_PARTIAL_REPAYMENT_NGN,
  REDIS_KEYS,
} from '@/common/constants';
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
  LoanNotActiveException,
  LoanNotFoundException,
  NoUnmatchedInflowException,
  PendingLoanAlreadyExistsException,
  RepaymentAccountNotReadyException,
} from '@/common/errors/bitmonie.errors';
import { UserRepaymentAccountsService } from '@/modules/user-repayment-accounts/user-repayment-accounts.service';
import { LoanNotificationsService } from '@/modules/loan-notifications/loan-notifications.service';
import type { CheckoutLoanDto } from './dto/checkout-loan.dto';

const CLAIM_INFLOW_WINDOW_MS  = 24 * 60 * 60 * 1000;
const TOPUP_CACHE_GRACE_SEC   = 5 * 60;
const PRISMA_UNIQUE_VIOLATION = 'P2002';

export type MatchMethod = 'AUTO_AMOUNT' | 'CUSTOMER_CLAIM' | 'OPS_MANUAL';

export interface CheckoutLoanResult {
  loan_id:                string;
  collateral_amount_sat:  bigint;
  payment_request:        string;
  payment_uri:            string;
  receiving_address:      string;
  expires_at:             Date;
  fee_breakdown: {
    origination_fee_ngn:          string;
    daily_custody_fee_ngn:        string;
    daily_interest_rate_bps:      number;
    projected_interest_ngn:       string;
    projected_custody_ngn:        string;
    projected_total_ngn:          string;
    amount_to_receive_ngn:        string;
    amount_to_repay_estimate_ngn: string;
    duration_days:                number;
  };
}

export interface CreditInflowResult {
  loan_id:                string;
  new_status:             LoanStatus;
  applied_to_custody:     string;
  applied_to_interest:    string;
  applied_to_principal:   string;
  overpay_ngn:            string;
  outstanding_ngn:        string;
}

export interface CollateralTopUpResult {
  topup_id:           string;
  loan_id:            string;
  payment_request:    string;
  payment_uri:        string;
  receiving_address:  string;
  expires_at:         Date;
}

export interface RepaymentInstructionsResult {
  loan_id: string;
  outstanding: {
    principal_ngn:         string;
    accrued_interest_ngn:  string;
    accrued_custody_ngn:   string;
    total_outstanding_ngn: string;
    days_elapsed:          number;
  };
  repayment_account: {
    virtual_account_no:   string;
    virtual_account_name: string;
    bank_name:            string;
    provider:             string;
  };
  minimum_partial_repayment_ngn: string;
}

@Injectable()
export class LoansService {
  private readonly logger = new Logger(LoansService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly price_feed: PriceFeedService,
    private readonly calculator: CalculatorService,
    private readonly accrual: AccrualService,
    private readonly loan_status: LoanStatusService,
    private readonly payment_requests: PaymentRequestsService,
    @Inject(PRICE_QUOTE_PROVIDER)
    private readonly price_quote: PriceQuoteProvider,
    @Inject(COLLATERAL_PROVIDER)
    private readonly collateral_provider: CollateralProvider,
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
    private readonly user_repayment_accounts: UserRepaymentAccountsService,
    private readonly notifications: LoanNotificationsService,
    private readonly collateral_release: CollateralReleaseService,
  ) {}

  async checkoutLoan(user: User, dto: CheckoutLoanDto): Promise<CheckoutLoanResult> {
    if (!user.loan_enabled) throw new LoanDisabledException();
    if (!user.disbursement_enabled) throw new DisbursementDisabledException();

    // At most ONE PENDING_COLLATERAL loan per user. Race-proofed at the DB layer
    // by the partial unique index `loans_user_id_pending_unique`; pre-check gives
    // a clean 409 before we waste a Lightning invoice on the rejected attempt.
    const existing_pending = await this.prisma.loan.count({
      where: { user_id: user.id, status: LoanStatus.PENDING_COLLATERAL },
    });
    if (existing_pending > 0) throw new PendingLoanAlreadyExistsException();

    const disburse_account = await this._resolveDefaultAccount(user.id, dto.disbursement_account_id);

    const [sat_rates, btc_usd_rate] = await Promise.all([
      this.price_feed.getCurrentRate(AssetPair.SAT_NGN),
      this.price_quote.getBtcUsdRate(),
    ]);

    const calc = this.calculator.calculate({
      principal_ngn: dto.principal_decimal,
      duration_days: dto.duration_days,
      sat_ngn_rate:  sat_rates.rate_sell,
      btc_usd_rate,
    });

    const due_at = new Date(Date.now() + dto.duration_days * 24 * 60 * 60 * 1000);

    let loan;
    try {
      loan = await this.prisma.$transaction(async (tx) => {
        const new_loan = await tx.loan.create({
          data: {
            user_id:                    user.id,
            disbursement_account_id:    disburse_account.id,
            collateral_amount_sat:      calc.collateral_amount_sat,
            ltv_percent:                calc.ltv_percent,
            principal_ngn:              dto.principal_decimal,
            origination_fee_ngn:        calc.origination_fee_ngn,
            daily_interest_rate_bps:    calc.daily_interest_rate_bps,
            daily_custody_fee_ngn:      calc.daily_custody_fee_ngn,
            initial_collateral_usd:    calc.initial_collateral_usd,
            duration_days:              dto.duration_days,
            sat_ngn_rate_at_creation:   calc.sat_ngn_rate_at_creation,
            collateral_release_address: dto.collateral_release_address,
            status:                     LoanStatus.PENDING_COLLATERAL,
            // DTO validation has already enforced dto.terms_accepted === true.
            // Stamp the moment of acceptance for the consumer-protection audit.
            terms_accepted_at:          new Date(),
            due_at,
          },
        });

        await this.loan_status.transition(tx, {
          loan_id:      new_loan.id,
          user_id:      user.id,
          from_status:  null,
          to_status:    LoanStatus.PENDING_COLLATERAL,
          triggered_by: StatusTrigger.CUSTOMER,
          reason_code:  LoanReasonCodes.LOAN_CREATED,
        });

        return new_loan;
      });
    } catch (err) {
      // Race against the partial unique `loans_user_id_pending_unique`: a second
      // concurrent checkout slipped past the count pre-check above.
      if (
        err && typeof err === 'object' && 'code' in err &&
        (err as { code: string }).code === PRISMA_UNIQUE_VIOLATION
      ) {
        throw new PendingLoanAlreadyExistsException();
      }
      throw err;
    }

    let payment_request_record;
    try {
      payment_request_record = await this.payment_requests.create({
        user_id:        user.id,
        source_type:    'LOAN',
        source_id:      loan.id,
        collateral_sat: calc.collateral_amount_sat,
        memo:           `Bitmonie loan collateral — ${dto.principal_ngn.toLocaleString('en-NG')} NGN`,
      });
    } catch {
      throw new CollateralInvoiceFailedException();
    }

    const bolt11 = payment_request_record.payment_request ?? '';

    // Customer-facing "loan created — awaiting collateral" email. Errors are
    // swallowed inside the notifications service so a flaky email provider
    // can never break checkout.
    await this.notifications.notifyLoanCreated({
      loan_id:                      loan.id,
      user_id:                      user.id,
      principal_ngn:                dto.principal_decimal,
      origination_fee_ngn:          calc.origination_fee_ngn,
      amount_to_receive_ngn:        calc.amount_to_receive_ngn,
      amount_to_repay_estimate_ngn: calc.amount_to_repay_estimate_ngn,
      collateral_amount_sat:        calc.collateral_amount_sat,
      duration_days:                dto.duration_days,
      expires_at:                   payment_request_record.expires_at,
    });

    return {
      loan_id:               loan.id,
      collateral_amount_sat: calc.collateral_amount_sat,
      payment_request:       bolt11,
      payment_uri:           bolt11 ? `lightning:${bolt11}` : '',
      receiving_address:     payment_request_record.receiving_address,
      expires_at:            payment_request_record.expires_at,
      fee_breakdown: {
        origination_fee_ngn:          calc.origination_fee_ngn.toFixed(2),
        daily_custody_fee_ngn:        calc.daily_custody_fee_ngn.toFixed(2),
        daily_interest_rate_bps:      calc.daily_interest_rate_bps,
        projected_interest_ngn:       calc.projected_interest_ngn.toFixed(2),
        projected_custody_ngn:        calc.projected_custody_ngn.toFixed(2),
        projected_total_ngn:          calc.projected_total_ngn.toFixed(2),
        amount_to_receive_ngn:        calc.amount_to_receive_ngn.toFixed(2),
        amount_to_repay_estimate_ngn: calc.amount_to_repay_estimate_ngn.toFixed(2),
        duration_days:                dto.duration_days,
      },
    };
  }

  async getLoan(user_id: string, loan_id: string) {
    const loan = await this.prisma.loan.findFirst({
      where: { id: loan_id, user_id },
      include: {
        status_logs:          { orderBy: { created_at: 'asc' } },
        disbursement_account: true,
        repayments:           { orderBy: { created_at: 'asc' } },
      },
    });
    if (!loan) throw new LoanNotFoundException();

    const outstanding = this.accrual.compute({
      loan,
      repayments: loan.repayments.map(this._toAccrualRepayment),
      as_of: new Date(),
    });

    return {
      ...loan,
      outstanding: {
        principal_ngn:         outstanding.principal_ngn.toFixed(2),
        accrued_interest_ngn:  outstanding.accrued_interest_ngn.toFixed(2),
        accrued_custody_ngn:   outstanding.accrued_custody_ngn.toFixed(2),
        total_outstanding_ngn: outstanding.total_outstanding_ngn.toFixed(2),
        days_elapsed:          outstanding.days_elapsed,
      },
    };
  }

  async getLoans(user_id: string) {
    return this.prisma.loan.findMany({
      where:   { user_id },
      orderBy: { created_at: 'desc' },
    });
  }

  // Customer-facing repayment instructions: tells the user where to send NGN
  // and how much they currently owe. Only meaningful while the loan is ACTIVE
  // — once REPAID/EXPIRED/LIQUIDATED/CANCELLED, repayments would land
  // unmatched (`no_active_loans`) and page ops, so we hard-reject here.
  //
  // The repayment VA is per-user (one permanent VA tied to BVN/NIN), shared
  // across every loan. ensureForUser is idempotent — read-only when the VA
  // exists, self-healing if a previous KYC-time provisioning attempt failed.
  async getRepaymentInstructions(
    user_id: string,
    loan_id: string,
  ): Promise<RepaymentInstructionsResult> {
    const loan = await this.prisma.loan.findFirst({
      where:   { id: loan_id, user_id },
      include: { repayments: { orderBy: { created_at: 'asc' } } },
    });
    if (!loan) throw new LoanNotFoundException();
    if (loan.status !== LoanStatus.ACTIVE) {
      throw new LoanNotActiveException({ status: loan.status });
    }

    const va = await this.user_repayment_accounts.ensureForUser(user_id);
    if (!va) throw new RepaymentAccountNotReadyException();

    const outstanding = this.accrual.compute({
      loan,
      repayments: loan.repayments.map(this._toAccrualRepayment),
      as_of: new Date(),
    });

    return {
      loan_id: loan.id,
      outstanding: {
        principal_ngn:         outstanding.principal_ngn.toFixed(2),
        accrued_interest_ngn:  outstanding.accrued_interest_ngn.toFixed(2),
        accrued_custody_ngn:   outstanding.accrued_custody_ngn.toFixed(2),
        total_outstanding_ngn: outstanding.total_outstanding_ngn.toFixed(2),
        days_elapsed:          outstanding.days_elapsed,
      },
      repayment_account: va.summary,
      minimum_partial_repayment_ngn: new Decimal(MIN_PARTIAL_REPAYMENT_NGN).toFixed(2),
    };
  }

  async cancelLoan(user_id: string, loan_id: string): Promise<void> {
    const loan = await this.prisma.loan.findFirst({ where: { id: loan_id, user_id } });
    if (!loan) throw new LoanNotFoundException();

    await this.prisma.$transaction(async (tx) => {
      await this.loan_status.transition(tx, {
        loan_id,
        user_id,
        from_status:  loan.status,
        to_status:    LoanStatus.CANCELLED,
        triggered_by: StatusTrigger.CUSTOMER,
        reason_code:  LoanReasonCodes.CUSTOMER_CANCELLED,
      });
    });
  }

  async setReleaseAddress(user_id: string, loan_id: string, address: string): Promise<void> {
    const loan = await this.prisma.loan.findFirst({ where: { id: loan_id, user_id } });
    if (!loan) throw new LoanNotFoundException();

    // Once collateral has been released, the address is permanently bound to
    // that send — changing it would mislead the loan history. Refuse silently
    // with a clear 409. Customer can still see what was sent in the timeline.
    if (loan.collateral_released_at !== null) {
      throw new CollateralAlreadyReleasedException({
        released_at: loan.collateral_released_at.toISOString(),
        reference:   loan.collateral_release_reference ?? undefined,
      });
    }

    await this.prisma.loan.update({
      where: { id: loan_id },
      data:  { collateral_release_address: address },
    });

    // Clear any prior "release failed" alert dedupe so the worker retries
    // immediately with the new address. The customer changing their address
    // is the most common signal that whatever was wrong (typo, wrong wallet)
    // is now fixed — no point making them wait the full 24h for the alert
    // window to expire before the worker tries again. If the loan isn't
    // REPAID yet, this is a no-op.
    if (loan.status === LoanStatus.REPAID && loan.collateral_released_at === null) {
      try {
        await this.redis.del(REDIS_KEYS.COLLATERAL_RELEASE_ALERTED(loan_id));
      } catch (err) {
        // Best-effort — Redis blip shouldn't break a successful PATCH.
        this.logger.warn(
          { loan_id, error: err instanceof Error ? err.message : String(err) },
          'setReleaseAddress: failed to clear release-alert dedupe key',
        );
      }
    }
  }

  async activateLoan(loan_id: string, collateral_received_at: Date): Promise<void> {
    const loan = await this.prisma.loan.findUniqueOrThrow({ where: { id: loan_id } });

    await this.prisma.$transaction(async (tx) => {
      await tx.loan.update({
        where: { id: loan_id },
        data:  { collateral_received_at },
      });
      await this.loan_status.transition(tx, {
        loan_id,
        user_id:      loan.user_id,
        from_status:  loan.status,
        to_status:    LoanStatus.ACTIVE,
        triggered_by: StatusTrigger.COLLATERAL_WEBHOOK,
        reason_code:  LoanReasonCodes.COLLATERAL_CONFIRMED,
      });
    });

    // Fired only when the transition from PENDING_COLLATERAL → ACTIVE actually
    // committed — duplicate Blink webhooks throw inside `transition()` (forward-
    // only invariant, CLAUDE.md §5.4) before reaching this line, so the email
    // sends at most once per loan activation.
    await this.notifications.notifyCollateralReceived({
      loan_id,
      user_id: loan.user_id,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // creditInflow
  //
  // Credits an inflow to a specific loan with the waterfall (custody → interest
  // → principal → overpay). All work runs in a single Prisma transaction that
  // locks the loan FOR UPDATE, inserts a LoanRepayment, marks the Inflow
  // matched, and transitions ACTIVE → REPAID if outstanding is fully cleared.
  //
  // Called by:
  //   - PalmPay collection webhook (auto-match when user has exactly 1 active loan)
  //   - POST /v1/loans/:id/claim-inflow (customer claim)
  //   - POST /v1/admin/inflows/:id/claim (ops manual override — v1.2)
  //
  // Idempotency: (a) LoanRepayment.inflow_id @unique blocks double-credit per
  // inflow; (b) processing an inflow against a REPAID loan is a no-op.
  // ─────────────────────────────────────────────────────────────────────────
  async creditInflow(params: {
    inflow_id:    string;
    loan_id:      string;
    amount_ngn:   Decimal;
    match_method: MatchMethod;
    // Bypass the MIN_PARTIAL_REPAYMENT_NGN floor when the customer is
    // explicitly applying a specific inflow they already own (the
    // "stack of cash rolls" UX). The floor exists to keep auto-matching
    // from acting on tiny accidental transfers — that rationale doesn't
    // apply when the customer themselves directs the apply.
    skip_floor?:  boolean;
  }): Promise<CreditInflowResult> {
    if (!params.skip_floor && params.amount_ngn.lt(MIN_PARTIAL_REPAYMENT_NGN)) {
      throw new InflowBelowFloorException({
        received_ngn: params.amount_ngn.toFixed(2),
        floor_ngn:    MIN_PARTIAL_REPAYMENT_NGN.toFixed(2),
      });
    }

    // The tx returns BOTH the public result and a notification receipt so we
    // can email the customer AFTER commit. Receipt stays null on the idempotent
    // already-REPAID branch so we don't double-email a duplicate webhook. We
    // mutate-via-let-in-closure would lose its type to `never` after async
    // narrowing, so the return-tuple form is the type-safe pattern.
    type RepaymentReceipt = {
      user_id:              string;
      applied_to_custody:   Decimal;
      applied_to_interest:  Decimal;
      applied_to_principal: Decimal;
      overpay_ngn:          Decimal;
      outstanding_ngn:      Decimal;
      is_fully_repaid:      boolean;
    };

    const { result, receipt } = await this.prisma.$transaction<{
      result:  CreditInflowResult;
      receipt: RepaymentReceipt | null;
    }>(async (tx) => {
      // Lock the loan row for the duration of this transaction.
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM loans WHERE id = ${params.loan_id}::uuid FOR UPDATE
      `;
      if (locked.length === 0) throw new LoanNotFoundException();

      const loan = await tx.loan.findUniqueOrThrow({
        where: { id: params.loan_id },
        include: { repayments: { orderBy: { created_at: 'asc' } } },
      });

      // Idempotent: a duplicate-processing attempt against a terminal loan is a no-op.
      if (loan.status === LoanStatus.REPAID) {
        return {
          result: {
            loan_id:              loan.id,
            new_status:           loan.status,
            applied_to_custody:   '0.00',
            applied_to_interest:  '0.00',
            applied_to_principal: '0.00',
            overpay_ngn:          '0.00',
            outstanding_ngn:      '0.00',
          },
          receipt: null,
        };
      }

      if (loan.status !== LoanStatus.ACTIVE) {
        throw new LoanNotActiveException({ status: loan.status });
      }

      // Accrual as of now — source of truth for what's currently owed.
      const now = new Date();
      const outstanding = this.accrual.compute({
        loan,
        repayments: loan.repayments.map(this._toAccrualRepayment),
        as_of: now,
      });

      // Waterfall: custody → interest → principal → overpay
      const { applied_to_custody, applied_to_interest, applied_to_principal, overpay_ngn } =
        this._waterfall(params.amount_ngn, outstanding);

      await tx.loanRepayment.create({
        data: {
          loan_id:              params.loan_id,
          inflow_id:            params.inflow_id,
          amount_ngn:           params.amount_ngn,
          applied_to_custody,
          applied_to_interest,
          applied_to_principal,
          overpay_ngn,
          match_method:         params.match_method,
        },
      });

      await tx.inflow.update({
        where: { id: params.inflow_id },
        data: {
          is_matched:  true,
          matched_at:  now,
          source_type: 'LOAN_REPAYMENT',
          source_id:   params.loan_id,
        },
      });

      // Recompute outstanding after applying this repayment.
      const new_outstanding_total = outstanding.total_outstanding_ngn
        .minus(applied_to_custody)
        .minus(applied_to_interest)
        .minus(applied_to_principal);

      const is_fully_repaid = new_outstanding_total.lte(0);

      if (is_fully_repaid) {
        await tx.loan.update({
          where: { id: params.loan_id },
          data: {
            repaid_at:           now,
            repayment_method:    RepaymentMethod.NGN,
            repayment_reference: params.inflow_id,
          },
        });
        await this.loan_status.transition(tx, {
          loan_id:      params.loan_id,
          user_id:      loan.user_id,
          from_status:  loan.status,
          to_status:    LoanStatus.REPAID,
          triggered_by: StatusTrigger.CUSTOMER,
          reason_code:  LoanReasonCodes.REPAYMENT_COMPLETED,
          reason_detail: overpay_ngn.gt(0)
            ? `Repayment closed loan with overpay ${overpay_ngn.toFixed(2)}`
            : undefined,
          metadata: {
            match_method:         params.match_method,
            applied_to_principal: applied_to_principal.toFixed(2),
            applied_to_interest:  applied_to_interest.toFixed(2),
            applied_to_custody:   applied_to_custody.toFixed(2),
            overpay_ngn:          overpay_ngn.toFixed(2),
          },
        });
      } else {
        await this.loan_status.transition(tx, {
          loan_id:      params.loan_id,
          user_id:      loan.user_id,
          from_status:  loan.status,
          to_status:    LoanStatus.ACTIVE,
          triggered_by: StatusTrigger.CUSTOMER,
          reason_code:  LoanReasonCodes.REPAYMENT_PARTIAL_NGN,
          metadata: {
            match_method:         params.match_method,
            applied_to_principal: applied_to_principal.toFixed(2),
            applied_to_interest:  applied_to_interest.toFixed(2),
            applied_to_custody:   applied_to_custody.toFixed(2),
            remaining_ngn:        new_outstanding_total.toFixed(2),
          },
        });
      }

      return {
        result: {
          loan_id:              params.loan_id,
          new_status:           is_fully_repaid ? LoanStatus.REPAID : LoanStatus.ACTIVE,
          applied_to_custody:   applied_to_custody.toFixed(2),
          applied_to_interest:  applied_to_interest.toFixed(2),
          applied_to_principal: applied_to_principal.toFixed(2),
          overpay_ngn:          overpay_ngn.toFixed(2),
          outstanding_ngn:      Decimal.max(new_outstanding_total, 0).toFixed(2),
        },
        receipt: {
          user_id:              loan.user_id,
          applied_to_custody,
          applied_to_interest,
          applied_to_principal,
          overpay_ngn,
          outstanding_ngn:      Decimal.max(new_outstanding_total, 0),
          is_fully_repaid,
        },
      };
    });

    // Customer receipt — fired only when an actual repayment was applied
    // (receipt stays null on the idempotent already-REPAID branch). Detailed
    // breakdown so the customer sees exactly what their money cleared and
    // whether the loan is now closed.
    if (receipt) {
      await this.notifications.notifyRepayment({
        loan_id:              result.loan_id,
        user_id:              receipt.user_id,
        amount_paid_ngn:      params.amount_ngn,
        applied_to_custody:   receipt.applied_to_custody,
        applied_to_interest:  receipt.applied_to_interest,
        applied_to_principal: receipt.applied_to_principal,
        overpay_ngn:          receipt.overpay_ngn,
        outstanding_ngn:      receipt.outstanding_ngn,
        is_fully_repaid:      receipt.is_fully_repaid,
      });
    }

    // Post-commit collateral release on REPAID. Fire-and-forget — the credit
    // result is already returnable to the caller; the release is its own
    // independently retryable concern. CollateralReleaseService handles the
    // not-eligible / no-address / send-failed cases internally (the
    // safety-net worker picks up anything that didn't land here). We
    // intentionally do NOT await this in the request hot path; in practice
    // the controller will return well before Blink's lnAddressPaymentSend
    // round-trip completes.
    if (receipt?.is_fully_repaid) {
      void this.collateral_release.releaseForLoan(result.loan_id).catch((err) => {
        this.logger.error(
          {
            loan_id: result.loan_id,
            error:   err instanceof Error ? err.message : String(err),
          },
          'Post-commit collateral release threw — worker will retry on next tick',
        );
      });
    }

    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // createCollateralTopUp
  //
  // Creates a fresh variable-amount Lightning invoice for a collateral top-up
  // on an ACTIVE loan. The customer can then send any amount of SAT to defend
  // the loan against liquidation.
  //
  // Constraints (per design §6):
  //   - Loan must belong to the authenticated user.
  //   - Loan must be in ACTIVE status.
  //   - At most one PENDING_COLLATERAL top-up per loan at a time (enforced by
  //     a partial unique index in the migration; we translate the unique-violation
  //     to AddCollateralAlreadyPendingException).
  //   - 30-min invoice expiry.
  //
  // Side effects:
  //   - Inserts a CollateralTopUp row.
  //   - Sets a Redis cache key `collateral_topup:pending:{receiving_address}`
  //     so the Blink collateral webhook can resolve the inflow on receipt.
  // ─────────────────────────────────────────────────────────────────────────
  async createCollateralTopUp(user_id: string, loan_id: string): Promise<CollateralTopUpResult> {
    const loan = await this.prisma.loan.findFirst({ where: { id: loan_id, user_id } });
    if (!loan) throw new LoanNotFoundException();
    if (loan.status !== LoanStatus.ACTIVE) {
      throw new LoanNotActiveException({ status: loan.status });
    }

    let invoice;
    try {
      invoice = await this.collateral_provider.createNoAmountInvoice({
        memo:           `Bitmonie loan ${loan_id} — collateral top-up`,
        expiry_seconds: COLLATERAL_TOPUP_EXPIRY_SEC,
      });
    } catch {
      throw new CollateralInvoiceFailedException();
    }

    let topup;
    try {
      topup = await this.prisma.collateralTopUp.create({
        data: {
          loan_id,
          collateral_provider:     'blink',
          collateral_provider_ref: invoice.provider_reference,
          payment_request:         invoice.payment_request,
          receiving_address:       invoice.receiving_address,
          expected_amount_sat:     BigInt(0),     // variable-amount invoice; payer chooses
          expires_at:              invoice.expires_at,
          status:                  TopUpStatus.PENDING_COLLATERAL,
        },
      });
    } catch (err) {
      if (
        err && typeof err === 'object' && 'code' in err &&
        (err as { code: string }).code === PRISMA_UNIQUE_VIOLATION
      ) {
        throw new AddCollateralAlreadyPendingException();
      }
      throw err;
    }

    const ttl_sec =
      Math.ceil((invoice.expires_at.getTime() - Date.now()) / 1000) + TOPUP_CACHE_GRACE_SEC;
    await this.redis.set(
      REDIS_KEYS.COLLATERAL_TOPUP_PENDING(invoice.receiving_address),
      topup.id,
      'EX',
      Math.max(ttl_sec, 1),
    );

    return {
      topup_id:          topup.id,
      loan_id,
      payment_request:   invoice.payment_request,
      payment_uri:       invoice.payment_request ? `lightning:${invoice.payment_request}` : '',
      receiving_address: invoice.receiving_address,
      expires_at:        invoice.expires_at,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // claimInflow
  //
  // Customer claim path: when a customer has 2+ ACTIVE loans (or the auto-match
  // failed for any reason), they hit this endpoint to assert "credit my recent
  // unmatched repayment to THIS loan."
  //
  // Lookup rules (per design §10):
  //   - Loan must belong to the authenticated user and be in a creditable state
  //     (ACTIVE — REPAID is short-circuited by creditInflow itself).
  //   - Find the most recent unmatched Inflow for this user where:
  //       amount_ngn >= MIN_PARTIAL_REPAYMENT_NGN  (floor)
  //       created_at >= now − 24h                  (stale window)
  //       is_matched = false, source_type IS NULL
  //   - If none found: 404 NoUnmatchedInflowException.
  //   - Otherwise credit it via creditInflow with match_method='CUSTOMER_CLAIM'.
  // ─────────────────────────────────────────────────────────────────────────
  async claimInflow(user_id: string, loan_id: string): Promise<CreditInflowResult> {
    const loan = await this.prisma.loan.findFirst({ where: { id: loan_id, user_id } });
    if (!loan) throw new LoanNotFoundException();
    if (loan.status !== LoanStatus.ACTIVE) {
      throw new LoanNotActiveException({ status: loan.status });
    }

    const window_start = new Date(Date.now() - CLAIM_INFLOW_WINDOW_MS);

    const candidate = await this.prisma.inflow.findFirst({
      where: {
        user_id,
        is_matched:  false,
        source_type: null,
        currency:    'NGN',
        created_at:  { gte: window_start },
        amount:      { gte: MIN_PARTIAL_REPAYMENT_NGN.toFixed(2) },
      },
      orderBy: { created_at: 'desc' },
    });

    if (!candidate) throw new NoUnmatchedInflowException();

    return this.applyInflowToLoan(user_id, candidate.id, loan_id);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // applyInflowToLoan
  //
  // Customer-explicit "stack of cash rolls" claim — the customer picks one of
  // their unmatched inflows and applies it to one of their ACTIVE loans.
  // Surfaces the inflow list via GET /v1/inflows/unmatched; this endpoint is
  // the apply action.
  //
  // Validation:
  //   - Inflow must exist, belong to user, currency=NGN, and be unmatched.
  //   - Inflow must NOT carry an "untrusted" reason marker
  //     (requery_mismatch / requery_unconfirmed / credit_failed) — those are
  //     ops-only triage states, not customer-claimable.
  //   - Loan must belong to user and be in a creditable state (ACTIVE; REPAID
  //     short-circuits inside creditInflow as a no-op).
  //
  // Floor: bypassed (skip_floor: true). The customer sent the money and is
  // directing it explicitly — no auto-match noise risk.
  // ─────────────────────────────────────────────────────────────────────────
  async applyInflowToLoan(
    user_id:   string,
    inflow_id: string,
    loan_id:   string,
  ): Promise<CreditInflowResult> {
    const loan = await this.prisma.loan.findFirst({ where: { id: loan_id, user_id } });
    if (!loan) throw new LoanNotFoundException();
    if (loan.status !== LoanStatus.ACTIVE) {
      throw new LoanNotActiveException({ status: loan.status });
    }

    const inflow = await this.prisma.inflow.findFirst({
      where: { id: inflow_id, user_id, currency: 'NGN' },
    });
    if (!inflow) throw new InflowNotFoundException();

    if (inflow.is_matched) {
      throw new InflowAlreadyMatchedException({
        matched_at: inflow.matched_at?.toISOString(),
        source_id:  inflow.source_id ?? undefined,
      });
    }

    // Untrusted-state guard: persisted Inflows whose PalmPay re-query failed
    // or disagreed must not auto-apply via the customer path. Ops handles them.
    const reason = (inflow.provider_response as { bitmonie_unmatched_reason?: string } | null)
      ?.bitmonie_unmatched_reason;
    if (reason === 'requery_mismatch' || reason === 'requery_unconfirmed' || reason === 'credit_failed') {
      throw new InflowNotFoundException();
    }

    return this.creditInflow({
      inflow_id,
      loan_id,
      amount_ngn:   new Decimal(inflow.amount.toString()),
      match_method: 'CUSTOMER_CLAIM',
      skip_floor:   true,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // findActiveLoanMatchingOutstanding
  //
  // Smart-match for the multi-ACTIVE-loan branch of the collection webhook
  // (CLAUDE.md §5.7a). When a user has 2+ ACTIVE loans, the webhook can't
  // safely auto-credit by user — but if exactly one of those loans has a
  // current outstanding equal to the inflow amount (within a tight tolerance
  // for daily accrual fractions), that's almost certainly the loan the
  // customer is paying off. If multiple loans match, oldest by created_at
  // wins (deterministic tiebreaker; customer can still dispute).
  //
  // Returns null when no loan's outstanding matches — the caller falls back
  // to the unmatched / claim-inflow path.
  // ─────────────────────────────────────────────────────────────────────────
  async findActiveLoanMatchingOutstanding(
    user_id:    string,
    amount_ngn: Decimal,
  ): Promise<{ loan_id: string; tiebreaker: 'unique' | 'oldest' } | null> {
    const active_loans = await this.prisma.loan.findMany({
      where:   { user_id, status: LoanStatus.ACTIVE },
      include: { repayments: { orderBy: { created_at: 'asc' } } },
      orderBy: { created_at: 'asc' },
    });

    if (active_loans.length === 0) return null;

    const now = new Date();
    const matches: Array<{ id: string; created_at: Date }> = [];

    for (const loan of active_loans) {
      const outstanding = this.accrual.compute({
        loan,
        repayments: loan.repayments.map(this._toAccrualRepayment),
        as_of:      now,
      });
      const diff = outstanding.total_outstanding_ngn.minus(amount_ngn).abs();
      if (diff.lte(INFLOW_OUTSTANDING_MATCH_TOLERANCE_NGN)) {
        matches.push({ id: loan.id, created_at: loan.created_at });
      }
    }

    if (matches.length === 0) return null;
    if (matches.length === 1) return { loan_id: matches[0]!.id, tiebreaker: 'unique' };

    // Multiple loans with matching outstanding — extremely unlikely in
    // practice (would need two loans with the same principal, custody, and
    // accrual state to within 50 kobo). Oldest wins; customer can dispute.
    matches.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
    return { loan_id: matches[0]!.id, tiebreaker: 'oldest' };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // listUnmatchedInflowsForUser
  //
  // Backs GET /v1/inflows/unmatched — the customer's "stack of cash rolls"
  // view. Returns NGN inflows for the user that are unmatched and trusted
  // (untrusted reason markers gate them out per applyInflowToLoan rules so
  // the list and the apply path agree on what's claimable).
  // ─────────────────────────────────────────────────────────────────────────
  async listUnmatchedInflowsForUser(user_id: string): Promise<Array<{
    id:                string;
    amount_ngn:        string;
    received_at:       Date;
    payer_name:        string | null;
    payer_bank_name:   string | null;
    received_via:      string;            // virtual account number the funds landed in
    status:            'CLAIMABLE' | 'BELOW_MINIMUM';
  }>> {
    const rows = await this.prisma.inflow.findMany({
      where:   { user_id, currency: 'NGN', is_matched: false, source_type: null },
      orderBy: { created_at: 'desc' },
    });

    type ProviderResponse = {
      payerAccountName?:           string;
      payerBankName?:              string;
      bitmonie_unmatched_reason?:  string;
    } | null;

    return rows
      .filter((row) => {
        const r = (row.provider_response as ProviderResponse)?.bitmonie_unmatched_reason;
        return r !== 'requery_mismatch' && r !== 'requery_unconfirmed' && r !== 'credit_failed';
      })
      .map((row) => {
        const pr           = row.provider_response as ProviderResponse;
        const amount       = new Decimal(row.amount.toString());
        const below_floor  = amount.lt(MIN_PARTIAL_REPAYMENT_NGN);
        return {
          id:              row.id,
          amount_ngn:      amount.toFixed(2),
          received_at:     row.created_at,
          payer_name:      pr?.payerAccountName ?? null,
          payer_bank_name: pr?.payerBankName    ?? null,
          received_via:    row.receiving_address,
          status:          below_floor ? 'BELOW_MINIMUM' as const : 'CLAIMABLE' as const,
        };
      });
  }

  private async _resolveDefaultAccount(user_id: string, account_id?: string) {
    if (account_id) {
      const account = await this.prisma.disbursementAccount.findFirst({
        where: { id: account_id, user_id, status: DisbursementAccountStatus.VERIFIED },
      });
      if (!account) throw new LoanDisbursementAccountRequiredException();
      return account;
    }

    const account = await this.prisma.disbursementAccount.findFirst({
      where: {
        user_id,
        is_default: true,
        status:     DisbursementAccountStatus.VERIFIED,
        kind:       { in: [DisbursementAccountKind.BANK, DisbursementAccountKind.MOBILE_MONEY] },
      },
    });
    if (!account) throw new LoanDisbursementAccountRequiredException();
    return account;
  }

  // Maps a Prisma LoanRepayment row to the shape accepted by AccrualService.
  // Decimal columns come back as Prisma Decimal — convert to decimal.js Decimal.
  private _toAccrualRepayment(r: {
    applied_to_principal: { toString: () => string };
    applied_to_interest:  { toString: () => string };
    applied_to_custody:   { toString: () => string };
    created_at:           Date;
  }): AccrualRepaymentInput {
    return {
      applied_to_principal: new Decimal(r.applied_to_principal.toString()),
      applied_to_interest:  new Decimal(r.applied_to_interest.toString()),
      applied_to_custody:   new Decimal(r.applied_to_custody.toString()),
      created_at:           r.created_at,
    };
  }

  // Pure waterfall: splits `amount` across custody → interest → principal → overpay.
  private _waterfall(
    amount: Decimal,
    outstanding: { accrued_custody_ngn: Decimal; accrued_interest_ngn: Decimal; principal_ngn: Decimal },
  ): {
    applied_to_custody:   Decimal;
    applied_to_interest:  Decimal;
    applied_to_principal: Decimal;
    overpay_ngn:          Decimal;
  } {
    let remaining = amount;

    const applied_to_custody = Decimal.min(remaining, outstanding.accrued_custody_ngn);
    remaining = remaining.minus(applied_to_custody);

    const applied_to_interest = Decimal.min(remaining, outstanding.accrued_interest_ngn);
    remaining = remaining.minus(applied_to_interest);

    const applied_to_principal = Decimal.min(remaining, outstanding.principal_ngn);
    remaining = remaining.minus(applied_to_principal);

    const overpay_ngn = remaining;

    return { applied_to_custody, applied_to_interest, applied_to_principal, overpay_ngn };
  }
}
