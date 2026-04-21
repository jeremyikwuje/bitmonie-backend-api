import { Injectable } from '@nestjs/common';
import { DisbursementRail, DisbursementStatus, DisbursementType } from '@prisma/client';
import type { Decimal } from 'decimal.js';
import { PrismaService } from '@/database/prisma.service';

export interface CreateForLoanParams {
  user_id:            string;
  source_id:          string;
  amount:             Decimal;
  currency:           string;
  disbursement_rail:  DisbursementRail;
  provider_name:      string;
  account_unique:     string;
  account_name:       string | null;
}

@Injectable()
export class DisbursementsService {
  constructor(private readonly prisma: PrismaService) {}

  async createForLoan(params: CreateForLoanParams) {
    return this.prisma.disbursement.create({
      data: {
        user_id:           params.user_id,
        disbursement_type: DisbursementType.LOAN,
        disbursement_rail: params.disbursement_rail,
        source_type:       DisbursementType.LOAN,
        source_id:         params.source_id,
        amount:            params.amount,
        currency:          params.currency,
        provider_name:     params.provider_name,
        account_unique:    params.account_unique,
        account_name:      params.account_name,
        status:            DisbursementStatus.PENDING,
      },
    });
  }

  async findById(id: string) {
    return this.prisma.disbursement.findFirst({
      where: { id },
      include: { outflows: true },
    });
  }

  async markProcessing(id: string) {
    return this.prisma.disbursement.update({
      where: { id },
      data: { status: DisbursementStatus.PROCESSING },
    });
  }

  async markSuccessful(id: string) {
    return this.prisma.disbursement.update({
      where: { id },
      data: { status: DisbursementStatus.SUCCESSFUL },
    });
  }

  async markFailed(id: string, reason: string) {
    return this.prisma.disbursement.update({
      where: { id },
      data: { status: DisbursementStatus.FAILED, failure_reason: reason },
    });
  }
}
