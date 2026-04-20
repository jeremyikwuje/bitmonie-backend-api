import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
  NotImplementedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiCookieAuth, ApiParam } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { KycService } from './kyc.service';
import { SubmitKycDto } from './dto/submit-kyc.dto';
import { RevokeKycDto } from './dto/revoke-kyc.dto';
import { SessionGuard } from '@/common/guards/session.guard';
import { CurrentUser, type AuthenticatedUser } from '@/common/decorators/current-user.decorator';
import { KycStatus } from '@prisma/client';

@ApiTags('kyc')
@Controller('kyc')
@UseGuards(SessionGuard)
@ApiCookieAuth('session')
export class KycController {
  constructor(private readonly kyc_service: KycService) {}

  @Post('tier-1')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiOperation({ summary: 'Submit Tier 1 identity verification (BVN / NIN / Passport)' })
  @ApiResponse({ status: 200, description: 'Identity verified' })
  @ApiResponse({ status: 403, description: 'Already under review' })
  @ApiResponse({ status: 409, description: 'Already verified' })
  @ApiResponse({ status: 422, description: 'Identity number invalid or unverifiable' })
  async submitTier1(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SubmitKycDto,
  ): Promise<{ message: string }> {
    return this.kyc_service.submitTier1(user.id, dto);
  }

  @Post('tier-2')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Submit Tier 2 liveness check — not available in v1.0' })
  @ApiResponse({ status: 501, description: 'Not implemented in v1.0' })
  submitTier2(): never {
    throw new NotImplementedException('Tier 2 liveness verification is not available yet.');
  }

  @Post('tier-3')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Submit Tier 3 address verification — not available in v1.0' })
  @ApiResponse({ status: 501, description: 'Not implemented in v1.0' })
  submitTier3(): never {
    throw new NotImplementedException('Tier 3 address verification is not available yet.');
  }

  @Post(':user_id/reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset a user\'s KYC to tier 0 — deletes all verifications' })
  @ApiParam({ name: 'user_id', description: 'Target user UUID' })
  @ApiResponse({ status: 200, description: 'KYC reset to unverified' })
  async resetKyc(
    @Param('user_id') user_id: string,
  ): Promise<{ message: string }> {
    return this.kyc_service.revokeToTier(user_id, { target_tier: 0 });
  }

  @Post(':user_id/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke a user\'s KYC to a specific tier — deletes all tiers above target' })
  @ApiParam({ name: 'user_id', description: 'Target user UUID' })
  @ApiResponse({ status: 200, description: 'KYC revoked to target tier' })
  @ApiResponse({ status: 400, description: 'Invalid target tier' })
  async revokeKyc(
    @Param('user_id') user_id: string,
    @Body() dto: RevokeKycDto,
  ): Promise<{ message: string }> {
    return this.kyc_service.revokeToTier(user_id, dto);
  }

  @Get('status')
  @ApiOperation({ summary: 'Get current KYC tier and verification status' })
  @ApiResponse({ status: 200, description: 'KYC status' })
  async getStatus(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{
    kyc_tier: number;
    verifications: Array<{ tier: number; status: KycStatus; verified_at: Date | null }>;
  }> {
    return this.kyc_service.getStatus(user.id);
  }
}
