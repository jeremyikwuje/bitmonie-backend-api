import {
  Body,
  Controller,
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
import { OpsLoansService } from './ops-loans.service';
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
}
