import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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
import { OpsDisbursementsService } from './ops-disbursements.service';
import { ListDisbursementsDto } from './dto/list-disbursements.dto';
import { CancelDisbursementDto } from './dto/cancel-disbursement.dto';
import { AbandonAttemptDto } from './dto/abandon-attempt.dto';

// Ops triage view of every disbursement (any status). GET is unfiltered by
// default; pass ?status=ON_HOLD to scope to the active triage queue. Retry
// creates a new Outflow attempt; cancel terminally closes the disbursement
// with a reason. Mirrors the audit-in-tx discipline used by OpsKycController.
function readRequestId(req: Request): string | null {
  const raw = req.headers['x-request-id'];
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return null;
}

@ApiTags('ops-disbursements')
@Controller('ops/disbursements')
@UseGuards(OpsGuard)
@ApiCookieAuth('ops_session')
export class OpsDisbursementsController {
  constructor(private readonly service: OpsDisbursementsService) {}

  @Get()
  @ApiOperation({
    summary: 'List disbursements (no implicit status filter — pass ?status=… to scope)',
    description:
      'Cursor-paginated. Read-only — no audit row written. By default returns all statuses; pass `status=ON_HOLD` for the active triage queue or any other DisbursementStatus to scope.',
  })
  @ApiResponse({ status: 200, description: 'List of disbursement summaries with cursor' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async list(
    @Query() query: ListDisbursementsDto,
  ): Promise<ReturnType<OpsDisbursementsService['list']>> {
    return this.service.list(query);
  }

  @Post('recreate-for-loan/:loan_id')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Recreate a disbursement for an ACTIVE loan whose previous disbursement was cancelled',
    description:
      "Use when a loan reached ACTIVE but the original disbursement was terminally cancelled (or otherwise never funded the customer). Re-snapshots the loan's CURRENT default disbursement_account and dispatches a fresh Disbursement + Outflow. Rejects when the loan isn't ACTIVE, when a non-terminal disbursement already exists for the loan, or when no default account / no provider_code is set. Writes one ops_audit_logs row with action=disbursement.recreate.",
  })
  @ApiParam({ name: 'loan_id', description: 'Loan UUID' })
  @ApiResponse({ status: 202, description: 'New disbursement created and dispatched' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Loan not found' })
  @ApiResponse({ status: 409, description: 'Loan is not ACTIVE, or already has a non-terminal disbursement' })
  @ApiResponse({ status: 422, description: 'Loan has no default disbursement account / missing provider_code' })
  async recreateForLoan(
    @CurrentOpsUser() ops_user: AuthenticatedOpsUser,
    @Param('loan_id', new ParseUUIDPipe()) loan_id: string,
    @Req() req: Request,
  ): Promise<{ message: string; disbursement_id: string }> {
    const { disbursement_id } = await this.service.recreateForActiveLoan(loan_id, {
      ops_user_id: ops_user.id,
      request_id:  readRequestId(req),
      ip_address:  req.ip ?? null,
    });
    return { message: 'New disbursement created and dispatched.', disbursement_id };
  }

  @Get(':disbursement_id')
  @ApiOperation({
    summary: 'Disbursement detail with all outflow attempts',
    description: 'Read-only — no audit row written. Includes per-attempt failure_reason/failure_code.',
  })
  @ApiParam({ name: 'disbursement_id', description: 'Disbursement UUID' })
  @ApiResponse({ status: 200, description: 'Disbursement detail' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Disbursement not found' })
  async getById(
    @Param('disbursement_id', new ParseUUIDPipe()) disbursement_id: string,
  ): Promise<ReturnType<OpsDisbursementsService['getById']>> {
    return this.service.getById(disbursement_id);
  }

  @Post(':disbursement_id/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Retry a disbursement — creates a new Outflow attempt',
    description:
      'Requires the disbursement to be ON_HOLD. Creates a new Outflow with attempt_number + 1, dispatches it, and writes one ops_audit_logs row. Failed Outflow rows are immutable — a retry never updates the previous attempt.',
  })
  @ApiParam({ name: 'disbursement_id', description: 'Disbursement UUID' })
  @ApiResponse({ status: 202, description: 'Retry accepted — new outflow attempt dispatched' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Disbursement not found' })
  @ApiResponse({ status: 409, description: 'Disbursement is not ON_HOLD' })
  async retry(
    @CurrentOpsUser() ops_user: AuthenticatedOpsUser,
    @Param('disbursement_id', new ParseUUIDPipe()) disbursement_id: string,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    await this.service.retry(disbursement_id, {
      ops_user_id: ops_user.id,
      request_id:  readRequestId(req),
      ip_address:  req.ip ?? null,
    });
    return { message: 'Retry dispatched.' };
  }

  @Post(':disbursement_id/abandon-attempt')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Abandon the in-flight outflow attempt and move the disbursement to ON_HOLD',
    description:
      "Treats the active outflow attempt (PENDING or PROCESSING) as failed and parks the parent disbursement in ON_HOLD. Used when an attempt is genuinely stuck — stub provider in dev, or a real provider gone silent past the reconciler window. After this, ops can retry (which dispatches a fresh attempt against the currently-active provider) or cancel. The state transition reuses OutflowsService.handleFailure, so the resulting disbursement/alert state is identical to a webhook-reported failure — including the first-transition alert + daily digest pickup.",
  })
  @ApiParam({ name: 'disbursement_id', description: 'Disbursement UUID' })
  @ApiResponse({ status: 200, description: 'Outflow attempt abandoned, disbursement on hold' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Disbursement not found' })
  @ApiResponse({ status: 409, description: 'Disbursement is terminal or has no active outflow' })
  async abandonAttempt(
    @CurrentOpsUser() ops_user: AuthenticatedOpsUser,
    @Param('disbursement_id', new ParseUUIDPipe()) disbursement_id: string,
    @Body() dto: AbandonAttemptDto,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    await this.service.abandonAttempt(disbursement_id, dto.reason, {
      ops_user_id: ops_user.id,
      request_id:  readRequestId(req),
      ip_address:  req.ip ?? null,
    });
    return { message: 'Outflow attempt abandoned. Disbursement is now ON_HOLD.' };
  }

  @Post(':disbursement_id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Terminally cancel a disbursement (ops-only)',
    description:
      'Sets status=CANCELLED, captures cancellation_reason + cancelled_by_ops_user_id on the row, and writes one ops_audit_logs row in the SAME Prisma transaction. Cannot cancel SUCCESSFUL or already-CANCELLED disbursements.',
  })
  @ApiParam({ name: 'disbursement_id', description: 'Disbursement UUID' })
  @ApiResponse({ status: 200, description: 'Disbursement cancelled' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Disbursement not found' })
  @ApiResponse({ status: 409, description: 'Disbursement is in a terminal state' })
  async cancel(
    @CurrentOpsUser() ops_user: AuthenticatedOpsUser,
    @Param('disbursement_id', new ParseUUIDPipe()) disbursement_id: string,
    @Body() dto: CancelDisbursementDto,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    await this.service.cancel(disbursement_id, dto.reason, {
      ops_user_id: ops_user.id,
      request_id:  readRequestId(req),
      ip_address:  req.ip ?? null,
    });
    return { message: 'Disbursement cancelled.' };
  }
}
