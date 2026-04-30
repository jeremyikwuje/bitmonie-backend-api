import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { SessionGuard } from '@/common/guards/session.guard';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { LoansService } from '@/modules/loans/loans.service';
import { ApplyInflowDto } from './dto/apply-inflow.dto';

// Inflows surface — the customer's "stack of cash rolls" UX (CLAUDE.md §5.7a).
//
// When a PalmPay collection webhook can't auto-credit (multi-active-loans
// without a smart-match, or the user had no ACTIVE loan at receipt time), the
// inflow is persisted unmatched. The customer:
//   1. GET /v1/inflows/unmatched          — sees their pending inflows
//   2. POST /v1/inflows/:inflow_id/apply  — picks one and applies to a loan
//
// Untrusted inflows (PalmPay re-query disagreement, credit_failed) are gated
// out of both the list and the apply path — those stay ops-only.
@ApiTags('inflows')
@Controller('inflows')
export class InflowsController {
  constructor(private readonly loans: LoansService) {}

  @Get('unmatched')
  @UseGuards(SessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List the customer\'s unmatched repayment inflows',
    description:
      'Returns NGN inflows received against the user\'s repayment account that have not been ' +
      'applied to any loan yet. Each row carries a `status` of CLAIMABLE (above the partial-' +
      'repayment minimum) or BELOW_MINIMUM (under N10,000 — only applyable via the customer ' +
      'apply endpoint, not via auto-match).',
  })
  @ApiResponse({ status: 200, description: 'List of unmatched inflows' })
  async listUnmatched(@CurrentUser() user: User): Promise<{
    items: Awaited<ReturnType<LoansService['listUnmatchedInflowsForUser']>>;
  }> {
    const items = await this.loans.listUnmatchedInflowsForUser(user.id);
    return { items };
  }

  @Post(':inflow_id/apply')
  @UseGuards(SessionGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Apply this unmatched inflow to a loan',
    description:
      'Credits the chosen unmatched inflow against the chosen ACTIVE loan via the standard ' +
      'waterfall (custody → interest → principal → overpay). The N10,000 floor is bypassed on ' +
      'this customer-explicit path — the floor exists to keep auto-matching from acting on ' +
      'tiny accidental transfers, which doesn\'t apply when the customer themselves directs ' +
      'the apply. Idempotency-Key header required.',
  })
  @ApiResponse({ status: 200, description: 'Inflow applied — repayment credited' })
  @ApiResponse({ status: 404, description: 'Inflow not found, not yours, or in an untrusted state; or loan not found' })
  @ApiResponse({ status: 409, description: 'Inflow already matched, or loan not ACTIVE' })
  async applyInflow(
    @CurrentUser() user: User,
    @Param('inflow_id', ParseUUIDPipe) inflow_id: string,
    @Body() dto: ApplyInflowDto,
  ) {
    return this.loans.applyInflowToLoan(user.id, inflow_id, dto.loan_id);
  }
}
