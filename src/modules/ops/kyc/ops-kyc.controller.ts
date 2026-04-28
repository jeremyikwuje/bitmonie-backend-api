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
import { KycService } from '@/modules/kyc/kyc.service';
import { RevokeKycDto } from '@/modules/kyc/dto/revoke-kyc.dto';
import {
  UserRepaymentAccountsService,
  type UserRepaymentAccountSummary,
} from '@/modules/user-repayment-accounts/user-repayment-accounts.service';
import { OpsAuditService } from '@/modules/ops/auth/ops-audit.service';
import { OpsGuard } from '@/common/guards/ops-session.guard';
import {
  CurrentOpsUser,
  type AuthenticatedOpsUser,
} from '@/common/decorators/current-ops-user.decorator';
import { OPS_ACTION, OPS_TARGET_TYPE } from '@/common/constants/ops-actions';
import { KycNotFoundException } from '@/common/errors/bitmonie.errors';

// `request_id` propagation matches GlobalExceptionFilter (CLAUDE.md §5.9):
// read `x-request-id` directly off the request, no AsyncLocalStorage, no
// request-scoped DI. If upstream omits the header, request_id is null on the
// audit row — same null-tolerance the error response body has today.
function readRequestId(req: Request): string | null {
  const raw = req.headers['x-request-id'];
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return null;
}

@ApiTags('ops-kyc')
@Controller('ops/kyc')
@UseGuards(OpsGuard)
@ApiCookieAuth('ops_session')
export class OpsKycController {
  constructor(
    private readonly kyc_service: KycService,
    private readonly user_repayment_accounts: UserRepaymentAccountsService,
    private readonly ops_audit: OpsAuditService,
  ) {}

  @Get(':user_id/verifications')
  @ApiOperation({
    summary: "List a target user's KYC verifications + raw provider responses",
    description:
      'Read-only — no audit row written. Returns each tier verification including provider_raw_response. Encrypted/hashed columns are never exposed.',
  })
  @ApiParam({ name: 'user_id', description: 'Target user UUID' })
  @ApiResponse({ status: 200, description: 'Verifications + raw provider responses' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async listVerifications(
    @Param('user_id', new ParseUUIDPipe()) user_id: string,
  ): Promise<ReturnType<KycService['listVerifications']>> {
    return this.kyc_service.listVerifications(user_id);
  }

  // Idempotent retry of post-KYC VA provisioning. Closes the gap where
  // KycService.submitTier1 swallows VA-provisioner failures so KYC itself
  // doesn't fail. Existing VA → returns the existing summary, no provider
  // call, no audit row (an idempotent no-op is read-only — §1.2). Newly
  // created VA → audit row written in the SAME tx as the VA insert.
  @Post(':user_id/provision-va')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Provision (or return) the user's permanent NGN repayment VA",
    description:
      'Idempotent. If a VA already exists, returns the existing summary without contacting the collection provider and without writing an audit row. On first provisioning, creates the VA and writes one ops_audit_logs row in a single Prisma transaction.',
  })
  @ApiParam({ name: 'user_id', description: 'Target user UUID' })
  @ApiResponse({ status: 200, description: 'VA summary' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Target user has no tier-1 KYC to back a VA' })
  async provisionVa(
    @CurrentOpsUser() ops_user: AuthenticatedOpsUser,
    @Param('user_id', new ParseUUIDPipe()) user_id: string,
    @Req() req: Request,
  ): Promise<UserRepaymentAccountSummary> {
    const request_id = readRequestId(req);
    const ip_address = req.ip ?? null;

    const result = await this.user_repayment_accounts.ensureForUser(
      user_id,
      async (tx) => {
        await this.ops_audit.write(tx, {
          ops_user_id: ops_user.id,
          action:      OPS_ACTION.KYC_PROVISION_VA,
          target_type: OPS_TARGET_TYPE.USER,
          target_id:   user_id,
          request_id,
          ip_address,
        });
      },
    );

    if (!result) throw new KycNotFoundException();
    return result.summary;
  }

  @Post(':user_id/reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Reset a user's KYC to tier 0 — deletes all verifications",
    description:
      'Atomic: KycVerification rows are deleted, user.kyc_tier flipped to 0, and one ops_audit_logs row is written — all in a single Prisma transaction.',
  })
  @ApiParam({ name: 'user_id', description: 'Target user UUID' })
  @ApiResponse({ status: 200, description: 'KYC reset to unverified' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async reset(
    @CurrentOpsUser() ops_user: AuthenticatedOpsUser,
    @Param('user_id', new ParseUUIDPipe()) user_id: string,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    const request_id = readRequestId(req);
    const ip_address = req.ip ?? null;

    return this.kyc_service.revokeToTier(
      user_id,
      { target_tier: 0 },
      async (tx) => {
        await this.ops_audit.write(tx, {
          ops_user_id: ops_user.id,
          action:      OPS_ACTION.KYC_RESET,
          target_type: OPS_TARGET_TYPE.USER,
          target_id:   user_id,
          details:     { target_tier: 0 },
          request_id,
          ip_address,
        });
      },
    );
  }

  @Post(':user_id/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Revoke a user's KYC to a specific tier — deletes all tiers above",
    description:
      'Atomic: matching KycVerification rows are deleted, user.kyc_tier flipped, and one ops_audit_logs row is written — all in a single Prisma transaction.',
  })
  @ApiParam({ name: 'user_id', description: 'Target user UUID' })
  @ApiResponse({ status: 200, description: 'KYC revoked to target tier' })
  @ApiResponse({ status: 400, description: 'Invalid target tier' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async revoke(
    @CurrentOpsUser() ops_user: AuthenticatedOpsUser,
    @Param('user_id', new ParseUUIDPipe()) user_id: string,
    @Body() dto: RevokeKycDto,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    const request_id = readRequestId(req);
    const ip_address = req.ip ?? null;

    return this.kyc_service.revokeToTier(
      user_id,
      dto,
      async (tx) => {
        await this.ops_audit.write(tx, {
          ops_user_id: ops_user.id,
          action:      OPS_ACTION.KYC_REVOKE,
          target_type: OPS_TARGET_TYPE.USER,
          target_id:   user_id,
          details:     { target_tier: dto.target_tier },
          request_id,
          ip_address,
        });
      },
    );
  }
}
