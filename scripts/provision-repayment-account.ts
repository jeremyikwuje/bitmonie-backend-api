#!/usr/bin/env node
/**
 * One-off: provision a PalmPay virtual repayment account for an existing ACTIVE loan.
 * Calls LoanRepaymentAccountsService.provisionForLoan(loan_id) via a minimal Nest bootstrap.
 *
 * Usage:
 *   node --env-file=.env -r ts-node/register -r tsconfig-paths/register \
 *     scripts/provision-repayment-account.ts --loan-id <uuid>
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';
import { LoanRepaymentAccountsService } from '@/modules/loan-repayment-accounts/loan-repayment-accounts.service';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--loan-id');
  const loan_id = i >= 0 ? argv[i + 1] : undefined;
  if (!loan_id) { console.error('missing --loan-id'); process.exit(1); }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  const service = app.get(LoanRepaymentAccountsService);

  const result = await service.provisionForLoan(loan_id);
  console.log(JSON.stringify(result, null, 2));

  await app.close();
  process.exit(result ? 0 : 1);
}

void main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
