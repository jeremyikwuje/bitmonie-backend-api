import { Injectable } from '@nestjs/common';
import {
  DisbursementAccountKind,
  DisbursementAccountStatus,
  DisbursementRail,
  LoanStatus,
  StatusTrigger,
} from '@prisma/client';
import Decimal from 'decimal.js';
import type { User } from '@prisma/client';
import { AssetPair } from '@prisma/client';
import { PrismaService } from '@/database/prisma.service';
import { PriceFeedService } from '@/modules/price-feed/price-feed.service';
import { CalculatorService } from './calculator.service';
import { LoanStatusService } from './loan-status.service';
import { PaymentRequestsService } from '@/modules/payment-requests/payment-requests.service';
import { LoanReasonCodes } from '@/common/constants';
import {
  LoanDisbursementAccountRequiredException,
  LoanDisabledException,
  LoanNotFoundException,
  DisbursementDisabledException,
  CollateralInvoiceFailedException,
} from '@/common/errors/bitmonie.errors';
import type { CheckoutLoanDto } from './dto/checkout-loan.dto';

const NGN_RAILS: DisbursementRail[] = [DisbursementRail.BANK_TRANSFER, DisbursementRail.MOBILE_MONEY];

export interface CheckoutLoanResult {
  loan_id:           string;
  collateral_amount_sat: bigint;
  payment_request:   string;
  receiving_address: string;
  expires_at:        Date;
  fee_breakdown: {
    origination_fee_ngn: string;
    daily_fee_ngn:       string;
    total_fees_ngn:      string;
    total_amount_ngn:    string;
    duration_days:       number;
  };
}

@Injectable()
export class LoansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly price_feed: PriceFeedService,
    private readonly calculator: CalculatorService,
    private readonly loan_status: LoanStatusService,
    private readonly payment_requests: PaymentRequestsService,
  ) {}

  async checkoutLoan(user: User, dto: CheckoutLoanDto): Promise<CheckoutLoanResult> {
    if (!user.loan_enabled) throw new LoanDisabledException();
    if (!user.disbursement_enabled) throw new DisbursementDisabledException();

    const disburse_account = await this._resolveDefaultAccount(user.id, dto.disbursement_account_id);

    const [sat_rates, usdt_rates] = await Promise.all([
      this.price_feed.getCurrentRate(AssetPair.SAT_NGN),
      this.price_feed.getCurrentRate(AssetPair.USDT_NGN),
    ]);

    const calc = this.calculator.calculate({
      principal_ngn:  dto.principal_decimal,
      duration_days:  dto.duration_days,
      sat_ngn_rate:   sat_rates.rate_sell,
      usdt_ngn_rate:  usdt_rates.rate_sell,
    });

    const due_at = new Date(Date.now() + dto.duration_days * 24 * 60 * 60 * 1000);

    const loan = await this.prisma.$transaction(async (tx) => {
      const new_loan = await tx.loan.create({
        data: {
          user_id:                    user.id,
          disbursement_account_id:    disburse_account.id,
          collateral_amount_sat:      calc.collateral_amount_sat,
          ltv_percent:                calc.ltv_percent,
          principal_ngn:              calc.ltv_percent.eq(0) ? dto.principal_decimal : dto.principal_decimal,
          origination_fee_ngn:        calc.origination_fee_ngn,
          daily_fee_ngn:              calc.daily_fee_ngn,
          duration_days:              dto.duration_days,
          total_fees_ngn:             calc.total_fees_ngn,
          total_amount_ngn:           calc.total_amount_ngn,
          sat_ngn_rate_at_creation:   calc.sat_ngn_rate_at_creation,
          liquidation_rate_ngn:       calc.liquidation_rate_ngn,
          alert_rate_ngn:             calc.alert_rate_ngn,
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

    let payment_request_record;
    try {
      payment_request_record = await this.payment_requests.create({
        user_id:        user.id,
        source_type:    'LOAN',
        source_id:      loan.id,
        collateral_sat: calc.collateral_amount_sat,
        memo:           `Bitmonie loan collateral — N${dto.principal_ngn}`,
      });
    } catch {
      throw new CollateralInvoiceFailedException();
    }

    return {
      loan_id:              loan.id,
      collateral_amount_sat: calc.collateral_amount_sat,
      payment_request:      payment_request_record.payment_request ?? '',
      receiving_address:    payment_request_record.receiving_address,
      expires_at:           payment_request_record.expires_at,
      fee_breakdown: {
        origination_fee_ngn: calc.origination_fee_ngn.toFixed(2),
        daily_fee_ngn:       calc.daily_fee_ngn.toFixed(2),
        total_fees_ngn:      calc.total_fees_ngn.toFixed(2),
        total_amount_ngn:    calc.total_amount_ngn.toFixed(2),
        duration_days:       dto.duration_days,
      },
    };
  }

  async getLoan(user_id: string, loan_id: string) {
    const loan = await this.prisma.loan.findFirst({
      where: { id: loan_id, user_id },
      include: {
        status_logs:          { orderBy: { created_at: 'asc' } },
        disbursement_account: true,
      },
    });
    if (!loan) throw new LoanNotFoundException();
    return loan;
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
}
