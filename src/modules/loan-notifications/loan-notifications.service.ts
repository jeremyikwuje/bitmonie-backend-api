import { Inject, Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { displayNgn } from '@/common/formatting/ngn-display';
import { PrismaService } from '@/database/prisma.service';
import { EMAIL_PROVIDER, type EmailProvider } from '@/modules/auth/email.provider.interface';
import { DAILY_INTEREST_RATE_BPS } from '@/common/constants';
import {
  buildCollateralReceivedEmail,
  buildCollateralReleasedEmail,
  buildCollateralToppedUpEmail,
  buildCoverageWarnEmail,
  buildLoanCreatedEmail,
  buildLoanDisbursedEmail,
  buildMarginCallEmail,
  buildRepaymentEmail,
  type RepaymentAccountSummary,
} from './loan-notification-templates';

// Customer-facing notifications fired on key loan-lifecycle transitions.
// Errors never escape — financial code paths must not break when an email
// provider has a hiccup. Same swallow-and-log discipline as OpsAlertsService.
//
// All methods are awaited (so the email is ordered sensibly relative to the
// next service call) but any thrown provider error is caught internally,
// logged at error level, and turned into a no-op for the caller. The DB row
// is the source of truth — a missed email never blocks a loan transition.

export interface NotifyLoanCreatedParams {
  loan_id:                string;
  user_id:                string;
  principal_ngn:          Decimal;
  origination_fee_ngn:    Decimal;
  amount_to_receive_ngn:  Decimal;
  daily_interest_ngn:     Decimal;
  daily_custody_fee_ngn:  Decimal;
  collateral_amount_sat:  bigint;
  expires_at:             Date;
  payment_request:        string;
}

export interface NotifyCollateralReceivedParams {
  loan_id: string;
  user_id: string;
}

export interface NotifyLoanDisbursedParams {
  loan_id:        string;
  user_id:        string;
  amount_ngn:     Decimal;
  bank_name:      string;
  account_unique: string;
  account_name:   string | null;
}

export interface NotifyRepaymentParams {
  loan_id:              string;
  user_id:              string;
  amount_paid_ngn:      Decimal;
  applied_to_custody:   Decimal;
  applied_to_interest:  Decimal;
  applied_to_principal: Decimal;
  overpay_ngn:          Decimal;
  outstanding_ngn:      Decimal;
  is_fully_repaid:      boolean;
}

export interface NotifyCollateralToppedUpParams {
  loan_id:                  string;
  user_id:                  string;
  added_sat:                bigint;
  new_total_collateral_sat: bigint;
}

export interface NotifyCollateralReleasedParams {
  loan_id:            string;
  user_id:            string;
  amount_sat:         bigint;
  release_address:    string;
  provider_reference: string;
  released_at:        Date;
}

// Coverage-tier customer nudges (v1.2 no-duration / margin-call model). Both
// expect the worker to have computed coverage % and outstanding NGN already —
// the service only loads user + repayment VA + collateral SAT and renders.
export interface NotifyCoverageWarnParams {
  loan_id:          string;
  user_id:          string;
  coverage_percent: string;     // "118" — collateral as % of outstanding
  outstanding_ngn:  Decimal;
}

export interface NotifyMarginCallParams {
  loan_id:          string;
  user_id:          string;
  coverage_percent: string;     // "112" — collateral as % of outstanding
  outstanding_ngn:  Decimal;
}

@Injectable()
export class LoanNotificationsService {
  private readonly logger = new Logger(LoanNotificationsService.name);

  constructor(
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    private readonly prisma: PrismaService,
  ) {}

  async notifyLoanCreated(params: NotifyLoanCreatedParams): Promise<void> {
    const user = await this._loadUser(params.user_id);
    if (!user) return;

    const email = buildLoanCreatedEmail({
      first_name:            user.first_name,
      loan_id:               params.loan_id,
      principal_ngn:         displayNgn(params.principal_ngn, 'ceil'),
      origination_fee_ngn:   displayNgn(params.origination_fee_ngn, 'ceil'),
      amount_to_receive_ngn: displayNgn(params.amount_to_receive_ngn, 'floor'),
      daily_interest_ngn:    displayNgn(params.daily_interest_ngn, 'ceil'),
      daily_custody_fee_ngn: displayNgn(params.daily_custody_fee_ngn, 'ceil'),
      collateral_amount_sat: params.collateral_amount_sat,
      expires_at:            params.expires_at,
      payment_request:       params.payment_request,
    });

    await this._send(user.email, email, { event: 'loan_created', loan_id: params.loan_id });
  }

  async notifyCollateralReceived(params: NotifyCollateralReceivedParams): Promise<void> {
    const [user, loan] = await Promise.all([
      this._loadUser(params.user_id),
      this.prisma.loan.findUnique({
        where: { id: params.loan_id },
        select: {
          principal_ngn:         true,
          origination_fee_ngn:   true,
          daily_custody_fee_ngn: true,
        },
      }),
    ]);
    if (!user || !loan) {
      this.logger.warn(
        { event: 'collateral_received', loan_id: params.loan_id, user_id: params.user_id },
        'Notification skipped — user or loan not found',
      );
      return;
    }

    // Net amount that will actually hit the customer's bank — the headline
    // figure in the email. Computing here (rather than carrying through the
    // call chain) keeps the loan→notification boundary thin: the caller only
    // needs to say "this loan's collateral landed", not re-do the math.
    const principal_decimal   = new Decimal(loan.principal_ngn.toString());
    const origination_decimal = new Decimal(loan.origination_fee_ngn.toString());
    const net_decimal         = principal_decimal.minus(origination_decimal);
    const daily_custody       = new Decimal(loan.daily_custody_fee_ngn.toString());
    // Day-0 daily interest (drops as principal pays down — surfaced as the
    // headline rate; future repayments lower it piecewise).
    const daily_interest = principal_decimal.mul(DAILY_INTEREST_RATE_BPS).div(10_000);

    const email = buildCollateralReceivedEmail({
      first_name:            user.first_name,
      loan_id:               params.loan_id,
      principal_ngn:         displayNgn(principal_decimal, 'ceil'),
      origination_fee_ngn:   displayNgn(origination_decimal, 'ceil'),
      amount_to_receive_ngn: displayNgn(net_decimal, 'floor'),
      daily_interest_ngn:    displayNgn(daily_interest, 'ceil'),
      daily_custody_fee_ngn: displayNgn(daily_custody, 'ceil'),
    });

    await this._send(user.email, email, { event: 'collateral_received', loan_id: params.loan_id });
  }

  async notifyLoanDisbursed(params: NotifyLoanDisbursedParams): Promise<void> {
    const [user, loan, va] = await Promise.all([
      this._loadUser(params.user_id),
      this.prisma.loan.findUnique({
        where:  { id: params.loan_id },
        select: {
          principal_ngn:         true,
          origination_fee_ngn:   true,
          daily_custody_fee_ngn: true,
        },
      }),
      this._loadRepaymentAccount(params.user_id),
    ]);
    if (!user || !loan) {
      this.logger.warn(
        { event: 'loan_disbursed', loan_id: params.loan_id, user_id: params.user_id },
        'Notification skipped — user or loan not found',
      );
      return;
    }
    if (!va) {
      // No VA = no place for the customer to send repayment from. Log and skip
      // the email rather than send half-built instructions; the customer can
      // still see disbursement status in the dashboard.
      this.logger.warn(
        { event: 'loan_disbursed', loan_id: params.loan_id, user_id: params.user_id },
        'Notification skipped — repayment VA not provisioned',
      );
      return;
    }

    const principal_decimal = new Decimal(loan.principal_ngn.toString());
    const daily_custody     = new Decimal(loan.daily_custody_fee_ngn.toString());
    const daily_interest    = principal_decimal.mul(DAILY_INTEREST_RATE_BPS).div(10_000);

    const email = buildLoanDisbursedEmail({
      first_name:            user.first_name,
      loan_id:               params.loan_id,
      amount_ngn:            displayNgn(params.amount_ngn, 'floor'),
      principal_ngn:         displayNgn(principal_decimal, 'ceil'),
      origination_fee_ngn:   displayNgn(new Decimal(loan.origination_fee_ngn.toString()), 'ceil'),
      daily_interest_ngn:    displayNgn(daily_interest, 'ceil'),
      daily_custody_fee_ngn: displayNgn(daily_custody, 'ceil'),
      bank_name:             params.bank_name,
      account_unique:        params.account_unique,
      account_name:          params.account_name,
      repayment_account:     va,
    });

    await this._send(user.email, email, { event: 'loan_disbursed', loan_id: params.loan_id });
  }

  async notifyRepayment(params: NotifyRepaymentParams): Promise<void> {
    const [user, va, loan] = await Promise.all([
      this._loadUser(params.user_id),
      // Partial repayment emails embed the VA so customers know where to send
      // the next payment. The full-repayment template doesn't render it, so an
      // unprovisioned VA is only a hard skip on the partial path.
      params.is_fully_repaid ? Promise.resolve(null) : this._loadRepaymentAccount(params.user_id),
      // Full-repayment email shows the SAT amount + Lightning address so the
      // customer can verify before the release goes out. Partial doesn't read
      // these — but loading them unconditionally is one cheap query and keeps
      // the branching here, not at every caller.
      params.is_fully_repaid
        ? this.prisma.loan.findUnique({
            where:  { id: params.loan_id },
            select: { collateral_amount_sat: true, collateral_release_address: true },
          })
        : Promise.resolve(null),
    ]);
    if (!user) return;

    if (!params.is_fully_repaid && !va) {
      this.logger.warn(
        { event: 'repayment_partial', loan_id: params.loan_id, user_id: params.user_id },
        'Notification skipped — partial repayment receipt requires repayment VA',
      );
      return;
    }

    if (params.is_fully_repaid && !loan) {
      this.logger.warn(
        { event: 'repayment_full', loan_id: params.loan_id, user_id: params.user_id },
        'Notification skipped — full repayment receipt requires loan row',
      );
      return;
    }

    const email = buildRepaymentEmail({
      first_name:                 user.first_name,
      loan_id:                    params.loan_id,
      // Money customer paid us / applied to debts → ceil. Refundable overpay → floor.
      amount_paid_ngn:            displayNgn(params.amount_paid_ngn, 'ceil'),
      applied_to_custody:         displayNgn(params.applied_to_custody, 'ceil'),
      applied_to_interest:        displayNgn(params.applied_to_interest, 'ceil'),
      applied_to_principal:       displayNgn(params.applied_to_principal, 'ceil'),
      overpay_ngn:                displayNgn(params.overpay_ngn, 'floor'),
      outstanding_ngn:            displayNgn(params.outstanding_ngn, 'ceil'),
      is_fully_repaid:            params.is_fully_repaid,
      // va is only nullable on the full-repayment branch where the template
      // doesn't read it; cast through an empty placeholder so the type stays
      // strict without leaking nulls into the templates.
      repayment_account:          va ?? EMPTY_VA,
      collateral_amount_sat:      loan?.collateral_amount_sat ?? BigInt(0),
      collateral_release_address: loan?.collateral_release_address ?? null,
    });

    await this._send(user.email, email, {
      event:   params.is_fully_repaid ? 'repayment_full' : 'repayment_partial',
      loan_id: params.loan_id,
    });
  }

  async notifyCollateralToppedUp(params: NotifyCollateralToppedUpParams): Promise<void> {
    const user = await this._loadUser(params.user_id);
    if (!user) return;

    const email = buildCollateralToppedUpEmail({
      first_name:               user.first_name,
      loan_id:                  params.loan_id,
      added_sat:                params.added_sat,
      new_total_collateral_sat: params.new_total_collateral_sat,
    });

    await this._send(user.email, email, { event: 'collateral_topped_up', loan_id: params.loan_id });
  }

  async notifyCollateralReleased(params: NotifyCollateralReleasedParams): Promise<void> {
    const user = await this._loadUser(params.user_id);
    if (!user) return;

    const email = buildCollateralReleasedEmail({
      first_name:         user.first_name,
      loan_id:            params.loan_id,
      amount_sat:         params.amount_sat,
      release_address:    params.release_address,
      provider_reference: params.provider_reference,
      released_at:        params.released_at,
    });

    await this._send(user.email, email, { event: 'collateral_released', loan_id: params.loan_id });
  }

  // Customer coverage-warning email — fired by the liquidation-monitor worker
  // when collateral coverage first crosses below COVERAGE_WARN_TIER (1.20).
  // The worker handles dedupe (Redis SETNX); this method only renders + sends.
  async notifyCoverageWarn(params: NotifyCoverageWarnParams): Promise<void> {
    const [user, loan, va] = await Promise.all([
      this._loadUser(params.user_id),
      this.prisma.loan.findUnique({
        where:  { id: params.loan_id },
        select: { collateral_amount_sat: true },
      }),
      this._loadRepaymentAccount(params.user_id),
    ]);
    if (!user || !loan) {
      this.logger.warn(
        { event: 'coverage_warn', loan_id: params.loan_id, user_id: params.user_id },
        'Notification skipped — user or loan not found',
      );
      return;
    }
    if (!va) {
      this.logger.warn(
        { event: 'coverage_warn', loan_id: params.loan_id, user_id: params.user_id },
        'Notification skipped — repayment VA not provisioned',
      );
      return;
    }

    const email = buildCoverageWarnEmail({
      first_name:            user.first_name,
      loan_id:               params.loan_id,
      coverage_percent:      params.coverage_percent,
      outstanding_ngn:       displayNgn(params.outstanding_ngn, 'ceil'),
      collateral_amount_sat: loan.collateral_amount_sat,
      repayment_account:     va,
    });

    await this._send(user.email, email, { event: 'coverage_warn', loan_id: params.loan_id });
  }

  // Margin-call email — fired by the liquidation-monitor worker when coverage
  // crosses below COVERAGE_MARGIN_CALL_TIER (1.15). Urgent. No promised window:
  // the worker still auto-liquidates the moment coverage hits 1.10, regardless
  // of whether the customer has read this email.
  async notifyMarginCall(params: NotifyMarginCallParams): Promise<void> {
    const [user, loan, va] = await Promise.all([
      this._loadUser(params.user_id),
      this.prisma.loan.findUnique({
        where:  { id: params.loan_id },
        select: { collateral_amount_sat: true },
      }),
      this._loadRepaymentAccount(params.user_id),
    ]);
    if (!user || !loan) {
      this.logger.warn(
        { event: 'margin_call', loan_id: params.loan_id, user_id: params.user_id },
        'Notification skipped — user or loan not found',
      );
      return;
    }
    if (!va) {
      this.logger.warn(
        { event: 'margin_call', loan_id: params.loan_id, user_id: params.user_id },
        'Notification skipped — repayment VA not provisioned',
      );
      return;
    }

    const email = buildMarginCallEmail({
      first_name:            user.first_name,
      loan_id:               params.loan_id,
      coverage_percent:      params.coverage_percent,
      outstanding_ngn:       displayNgn(params.outstanding_ngn, 'ceil'),
      collateral_amount_sat: loan.collateral_amount_sat,
      repayment_account:     va,
    });

    await this._send(user.email, email, { event: 'margin_call', loan_id: params.loan_id });
  }

  private async _loadUser(user_id: string): Promise<{ email: string; first_name: string | null } | null> {
    return this.prisma.user.findUnique({
      where:  { id: user_id },
      select: { email: true, first_name: true },
    });
  }

  private async _loadRepaymentAccount(user_id: string): Promise<RepaymentAccountSummary | null> {
    const va = await this.prisma.userRepaymentAccount.findUnique({
      where:  { user_id },
      select: { virtual_account_no: true, virtual_account_name: true, bank_name: true },
    });
    return va ?? null;
  }

  private async _send(
    to: string,
    email: { subject: string; text_body: string; html_body: string },
    log_context: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.email.sendTransactional({ to, ...email });
    } catch (err) {
      this.logger.error(
        {
          ...log_context,
          error: err instanceof Error ? err.message : String(err),
        },
        'Loan notification email send failed',
      );
    }
  }
}

const EMPTY_VA: RepaymentAccountSummary = {
  virtual_account_no:   '',
  virtual_account_name: '',
  bank_name:            '',
};
