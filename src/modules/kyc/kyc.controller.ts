import {
  Controller,
  Post,
  Get,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  NotImplementedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiCookieAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { KycService } from './kyc.service';
import { SubmitKycDto } from './dto/submit-kyc.dto';
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

  @Get('verifications')
  @ApiOperation({
    summary: 'List the current user\'s KYC verifications with the raw provider response',
    description:
      'Returns each tier verification including provider_raw_response — the exact payload returned by the upstream KYC vendor (EaseID / Dojah / QoreID). Useful for debugging mismatches or auditing what the provider sent back. Encrypted/hashed columns are not exposed.',
  })
  @ApiResponse({ status: 200, description: 'Verifications + raw provider responses' })
  async listVerifications(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReturnType<KycService['listVerifications']>> {
    return this.kyc_service.listVerifications(user.id);
  }
}
