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

// Ops triage queue for disbursements that have outflow attempts but no
// successful outflow. The default GET filter is ON_HOLD — the active queue.
// Retry creates a new Outflow attempt; cancel terminally closes the
// disbursement with a reason. Mirrors the audit-in-tx discipline used by
// OpsKycController.
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
    summary: 'List disbursements (defaults to ON_HOLD — the active triage queue)',
    description:
      'Cursor-paginated. Read-only — no audit row written. Default status filter is ON_HOLD; pass `status=` to inspect any other state.',
  })
  @ApiResponse({ status: 200, description: 'List of disbursement summaries with cursor' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async list(
    @Query() query: ListDisbursementsDto,
  ): Promise<ReturnType<OpsDisbursementsService['list']>> {
    return this.service.list(query);
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
