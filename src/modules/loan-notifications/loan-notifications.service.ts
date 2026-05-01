import { Inject, Injectable, Logger } from '@nestjs/common';
import type Decimal from 'decimal.js';
import { PrismaService } from '@/database/prisma.service';
import { EMAIL_PROVIDER, type EmailProvider } from '@/modules/auth/email.provider.interface';
import {
  buildCollateralReceivedEmail,
  buildCollateralReleasedEmail,
  buildCollateralToppedUpEmail,
  buildLoanCreatedEmail,
  buildLoanDisbursedEmail,
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
  loan_id:                      string;
  user_id:                      string;
  principal_ngn:                Decimal;
  origination_fee_ngn:          Decimal;
  amount_to_receive_ngn:        Decimal;
  amount_to_repay_estimate_ngn: Decimal;
  collateral_amount_sat:        bigint;
  duration_days:                number;
  expires_at:                   Date;
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
      first_name:                   user.first_name,
      loan_id:                      params.loan_id,
      principal_ngn:                params.principal_ngn.toFixed(2),
      origination_fee_ngn:          params.origination_fee_ngn.toFixed(2),
      amount_to_receive_ngn:        params.amount_to_receive_ngn.toFixed(2),
      amount_to_repay_estimate_ngn: params.amount_to_repay_estimate_ngn.toFixed(2),
      collateral_amount_sat:        params.collateral_amount_sat,
      duration_days:                params.duration_days,
      expires_at:                   params.expires_at,
    });

    await this._send(user.email, email, { event: 'loan_created', loan_id: params.loan_id });
  }

  async notifyCollateralReceived(params: NotifyCollateralReceivedParams): Promise<void> {
    const [user, loan] = await Promise.all([
      this._loadUser(params.user_id),
      this.prisma.loan.findUnique({
        where: { id: params.loan_id },
        select: { principal_ngn: true, duration_days: true, due_at: true },
      }),
    ]);
    if (!user || !loan) {
      this.logger.warn(
        { event: 'collateral_received', loan_id: params.loan_id, user_id: params.user_id },
        'Notification skipped — user or loan not found',
      );
      return;
    }

    const email = buildCollateralReceivedEmail({
      first_name:    user.first_name,
      loan_id:       params.loan_id,
      principal_ngn: loan.principal_ngn.toString(),
      duration_days: loan.duration_days,
      due_at:        loan.due_at,
    });

    await this._send(user.email, email, { event: 'collateral_received', loan_id: params.loan_id });
  }

  async notifyLoanDisbursed(params: NotifyLoanDisbursedParams): Promise<void> {
    const [user, loan, va] = await Promise.all([
      this._loadUser(params.user_id),
      this.prisma.loan.findUnique({
        where:  { id: params.loan_id },
        select: { due_at: true, principal_ngn: true, origination_fee_ngn: true },
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

    const email = buildLoanDisbursedEmail({
      first_name:          user.first_name,
      loan_id:             params.loan_id,
      amount_ngn:          params.amount_ngn.toFixed(2),
      principal_ngn:       loan.principal_ngn.toFixed(2),
      origination_fee_ngn: loan.origination_fee_ngn.toFixed(2),
      bank_name:           params.bank_name,
      account_unique:      params.account_unique,
      account_name:        params.account_name,
      due_at:              loan.due_at,
      repayment_account:   va,
    });

    await this._send(user.email, email, { event: 'loan_disbursed', loan_id: params.loan_id });
  }

  async notifyRepayment(params: NotifyRepaymentParams): Promise<void> {
    const [user, va] = await Promise.all([
      this._loadUser(params.user_id),
      // Partial repayment emails embed the VA so customers know where to send
      // the next payment. The full-repayment template doesn't render it, so an
      // unprovisioned VA is only a hard skip on the partial path.
      params.is_fully_repaid ? Promise.resolve(null) : this._loadRepaymentAccount(params.user_id),
    ]);
    if (!user) return;

    if (!params.is_fully_repaid && !va) {
      this.logger.warn(
        { event: 'repayment_partial', loan_id: params.loan_id, user_id: params.user_id },
        'Notification skipped — partial repayment receipt requires repayment VA',
      );
      return;
    }

    const email = buildRepaymentEmail({
      first_name:           user.first_name,
      loan_id:              params.loan_id,
      amount_paid_ngn:      params.amount_paid_ngn.toFixed(2),
      applied_to_custody:   params.applied_to_custody.toFixed(2),
      applied_to_interest:  params.applied_to_interest.toFixed(2),
      applied_to_principal: params.applied_to_principal.toFixed(2),
      overpay_ngn:          params.overpay_ngn.toFixed(2),
      outstanding_ngn:      params.outstanding_ngn.toFixed(2),
      is_fully_repaid:      params.is_fully_repaid,
      // va is only nullable on the full-repayment branch where the template
      // doesn't read it; cast through an empty placeholder so the type stays
      // strict without leaking nulls into the templates.
      repayment_account:    va ?? EMPTY_VA,
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
