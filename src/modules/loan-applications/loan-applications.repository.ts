import { Injectable } from '@nestjs/common';
import type { LoanApplication, LoanApplicationCollateralType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { PrismaService } from '@/database/prisma.service';

export interface CreateLoanApplicationRow {
  first_name:             string;
  last_name:              string;
  email:                  string;
  phone:                  string;
  collateral_type:        LoanApplicationCollateralType;
  collateral_description: string | null;
  loan_amount_ngn:        Decimal;
  client_ip:              string | null;
  user_agent:             string | null;
}

@Injectable()
export class LoanApplicationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(row: CreateLoanApplicationRow): Promise<LoanApplication> {
    return this.prisma.loanApplication.create({
      data: {
        first_name:             row.first_name,
        last_name:              row.last_name,
        email:                  row.email,
        phone:                  row.phone,
        collateral_type:        row.collateral_type,
        collateral_description: row.collateral_description,
        loan_amount_ngn:        new Prisma.Decimal(row.loan_amount_ngn.toString()),
        client_ip:              row.client_ip,
        user_agent:             row.user_agent,
      },
    });
  }
}
