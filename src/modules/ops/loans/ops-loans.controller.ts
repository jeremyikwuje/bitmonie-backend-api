import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { OpsGuard } from '@/common/guards/ops-session.guard';
import {
  CurrentOpsUser,
  type AuthenticatedOpsUser,
} from '@/common/decorators/current-ops-user.decorator';
import {
  OpsLoansService,
  type LoanRemindersDiagnostic,
} from './ops-loans.service';
import { RestoreFromBadLiquidationDto } from './dto/restore-from-bad-liquidation.dto';

function readRequestId(req: Request): string | null {
  const raw = req.headers['x-request-id'];
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return null;
}

@ApiTags('ops-loans')
@Controller('ops/loans')
@UseGuards(OpsGuard)
@ApiCookieAuth('ops_session')
export class OpsLoansController {
  constructor(private readonly service: OpsLoansService) {}

  @Get(':loan_id/reminders')
  @ApiOperation({
    summary: "Diagnostic: which reminder slots have fired for this loan",
    description:
      'Read-only — no audit row written. For each known reminder slot, returns whether the dedup key (reminder_sent:{loan_id}:{slot}) is present in Redis and its remaining TTL. Also returns the loan-reminder worker heartbeat (healthy = ≤2× tick interval) and the slot the worker is currently expected to send. Lets ops disambiguate "scheduler down" vs "worker ran but skipped" vs "send succeeded but bounced".',
  })
  @ApiParam({ name: 'loan_id', description: 'Loan UUID' })
  @ApiResponse({ status: 200, description: 'Reminder diagnostic' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Loan not found' })
  async getReminders(
    @Param('loan_id', new ParseUUIDPipe()) loan_id: string,
  ): Promise<LoanRemindersDiagnostic> {
    return this.service.getReminders(loan_id);
  }

  @Post(':loan_id/restore-from-bad-liquidation')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reverse a LIQUIDATED loan back to ACTIVE when the liquidation was caused by a bad price-feed rate',
    description:
      'Refused unless the loan is LIQUIDATED AND `liquidation_rate_actual < sat_ngn_rate_at_creation × MIN_LIQUIDATION_RATE_FRACTION`. On success: clears liquidated_at + liquidation_rate_actual, flips status back to ACTIVE, writes one loan_status_logs row with reason_code=LIQUIDATION_REVERSED_BAD_RATE, and writes one ops_audit_logs row with action=loan.restore_bad_liquidation — all in the same transaction. Does NOT unwind any BlinkProvider.swapBtcToUsd that already executed against the seized BTC; ops must square the wallet position separately.',
  })
  @ApiParam({ name: 'loan_id', description: 'Loan UUID' })
  @ApiResponse({ status: 200, description: 'Loan restored to ACTIVE' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Loan not found' })
  @ApiResponse({ status: 409, description: 'Loan is not LIQUIDATED, or liquidation rate is plausibly market-driven (not bad-rate)' })
  async restoreFromBadLiquidation(
    @CurrentOpsUser() ops_user: AuthenticatedOpsUser,
    @Param('loan_id', new ParseUUIDPipe()) loan_id: string,
    @Body() dto: RestoreFromBadLiquidationDto,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    await this.service.restoreFromBadLiquidation(loan_id, dto.reason, {
      ops_user_id: ops_user.id,
      request_id:  readRequestId(req),
      ip_address:  req.ip ?? null,
    });
    return { message: 'Loan restored to ACTIVE.' };
  }

  @Post(':loan_id/release-collateral')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Manually release collateral SAT for a REPAID loan',
    description:
      'Drives the same CollateralReleaseService the live post-commit hand-off and the safety-net worker use, so all three converge on identical state. The ops_audit_logs row is written FIRST in its own transaction (records intent regardless of send outcome). The release attempt runs after the audit commits — on success the loan row is stamped with collateral_released_at + collateral_release_reference and a REPAID→REPAID self-transition row lands in loan_status_logs. Refused unless the loan is REPAID, has a collateral_release_address set, and has not already been released. Concurrent attempts (worker + ops + post-commit) coordinate via a Redis SETNX lock, so a stuck "in_flight" status means another caller holds the lock — wait and recheck.',
  })
  @ApiParam({ name: 'loan_id', description: 'Loan UUID' })
  @ApiResponse({ status: 200, description: 'Released, already-released, or in-flight' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Loan not found' })
  @ApiResponse({ status: 409, description: 'Loan not eligible for release (status, address, etc.)' })
  @ApiResponse({ status: 502, description: 'Provider rejected the send — safe to retry after fixing the cause' })
  async releaseCollateral(
    @CurrentOpsUser() ops_user: AuthenticatedOpsUser,
    @Param('loan_id', new ParseUUIDPipe()) loan_id: string,
    @Req() req: Request,
  ): Promise<{ status: string; reference: string | null }> {
    return this.service.releaseCollateral(loan_id, {
      ops_user_id: ops_user.id,
      request_id:  readRequestId(req),
      ip_address:  req.ip ?? null,
    });
  }
}
