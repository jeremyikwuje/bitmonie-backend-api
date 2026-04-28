import { Inject, Injectable } from '@nestjs/common';
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
import { PaymentRequestsService } from '@/modules/payment-requests/payment-requests.service';
import {
  COLLATERAL_PROVIDER,
  type CollateralProvider,
} from '@/modules/payment-requests/collateral.provider.interface';
import { PRICE_QUOTE_PROVIDER, type PriceQuoteProvider } from './price-quote.provider.interface';
import {
  COLLATERAL_TOPUP_EXPIRY_SEC,
  LoanReasonCodes,
  MIN_PARTIAL_REPAYMENT_NGN,
  REDIS_KEYS,
} from '@/common/constants';
import {
  AddCollateralAlreadyPendingException,
  CollateralInvoiceFailedException,
  DisbursementDisabledException,
  InflowBelowFloorException,
  LoanDisabledException,
  LoanDisbursementAccountRequiredException,
  LoanNotActiveException,
  LoanNotFoundException,
  NoUnmatchedInflowException,
  PendingLoanAlreadyExistsException,
} from '@/common/errors/bitmonie.errors';
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
    origination_fee_ngn:    string;
    daily_custody_fee_ngn:  string;
    daily_interest_rate_bps: number;
    projected_interest_ngn: string;
    projected_custody_ngn:  string;
    projected_total_ngn:    string;
    duration_days:          number;
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

@Injectable()
export class LoansService {
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
    return {
      loan_id:               loan.id,
      collateral_amount_sat: calc.collateral_amount_sat,
      payment_request:       bolt11,
      payment_uri:           bolt11 ? `lightning:${bolt11}` : '',
      receiving_address:     payment_request_record.receiving_address,
      expires_at:            payment_request_record.expires_at,
      fee_breakdown: {
        origination_fee_ngn:     calc.origination_fee_ngn.toFixed(2),
        daily_custody_fee_ngn:   calc.daily_custody_fee_ngn.toFixed(2),
        daily_interest_rate_bps: calc.daily_interest_rate_bps,
        projected_interest_ngn:  calc.projected_interest_ngn.toFixed(2),
        projected_custody_ngn:   calc.projected_custody_ngn.toFixed(2),
        projected_total_ngn:     calc.projected_total_ngn.toFixed(2),
        duration_days:           dto.duration_days,
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

    await this.prisma.loan.update({
      where: { id: loan_id },
      data:  { collateral_release_address: address },
    });
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
  }): Promise<CreditInflowResult> {
    if (params.amount_ngn.lt(MIN_PARTIAL_REPAYMENT_NGN)) {
      throw new InflowBelowFloorException({
        received_ngn: params.amount_ngn.toFixed(2),
        floor_ngn:    MIN_PARTIAL_REPAYMENT_NGN.toFixed(2),
      });
    }

    return this.prisma.$transaction(async (tx) => {
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
          loan_id:              loan.id,
          new_status:           loan.status,
          applied_to_custody:   '0.00',
          applied_to_interest:  '0.00',
          applied_to_principal: '0.00',
          overpay_ngn:          '0.00',
          outstanding_ngn:      '0.00',
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
        loan_id:              params.loan_id,
        new_status:           is_fully_repaid ? LoanStatus.REPAID : LoanStatus.ACTIVE,
        applied_to_custody:   applied_to_custody.toFixed(2),
        applied_to_interest:  applied_to_interest.toFixed(2),
        applied_to_principal: applied_to_principal.toFixed(2),
        overpay_ngn:          overpay_ngn.toFixed(2),
        outstanding_ngn:      Decimal.max(new_outstanding_total, 0).toFixed(2),
      };
    });
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

    return this.creditInflow({
      inflow_id:    candidate.id,
      loan_id,
      amount_ngn:   new Decimal(candidate.amount.toString()),
      match_method: 'CUSTOMER_CLAIM',
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
