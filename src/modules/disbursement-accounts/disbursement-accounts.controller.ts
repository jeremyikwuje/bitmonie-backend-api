import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import type { User, DisbursementAccountStatus } from '@prisma/client';
import { SessionGuard } from '@/common/guards/session.guard';
import { DisbursementAccountsService } from './disbursement-accounts.service';
import { AddDisbursementAccountDto } from './dto/add-disbursement-account.dto';
import { SetDefaultDisbursementAccountDto } from './dto/set-default-disbursement-account.dto';

type AuthRequest = Request & { user: User };

@ApiTags('Disbursement Accounts')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('disbursement-accounts')
export class DisbursementAccountsController {
  constructor(private readonly service: DisbursementAccountsService) {}

  @Post()
  @ApiOperation({
    summary: 'Add a disbursement account (email-verified users welcome)',
    description:
      'No KYC required. For BANK and MOBILE_MONEY kinds:\n' +
      '- If user has KYC tier-1: account name is fetched from the rail and matched against KYC legal name (85%+ required). ' +
      'Response includes account_holder_name and name_match_score.\n' +
      '- If user has no KYC (kyc_tier=0): name verification is skipped. ' +
      'account_holder_name and name_match_score will be null. Account is created without name validation.\n' +
      'CRYPTO_ADDRESS always skips name lookup regardless of KYC status.',
  })
  @ApiResponse({ status: 201, description: 'Account added (name verified if KYC present, unverified otherwise)' })
  @ApiResponse({ status: 400, description: 'Max accounts reached' })
  @ApiResponse({ status: 422, description: 'Name mismatch (only if user has KYC)' })
  async addAccount(
    @Req() req: AuthRequest,
    @Body() dto: AddDisbursementAccountDto,
  ): Promise<{
    id: string;
    account_holder_name: string | null;
    name_match_score: number | null;
    status: DisbursementAccountStatus;
    is_default: boolean;
    message: string;
  }> {
    return this.service.addAccount(req.user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List all disbursement accounts' })
  @ApiResponse({ status: 200, description: 'Accounts listed' })
  async listAccounts(@Req() req: AuthRequest) {
    return this.service.listAccounts(req.user.id);
  }

  @Patch(':account_id/default')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set a disbursement account as default' })
  @ApiParam({ name: 'account_id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Default updated' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  async setDefault(
    @Req() req: AuthRequest,
    @Param('account_id', ParseUUIDPipe) account_id: string,
    @Body() _dto: SetDefaultDisbursementAccountDto,
  ): Promise<{ message: string }> {
    return this.service.setDefault(req.user.id, account_id);
  }

  @Delete(':account_id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a disbursement account' })
  @ApiParam({ name: 'account_id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Account deleted; default auto-promotes to oldest remaining of that kind' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  async deleteAccount(
    @Req() req: AuthRequest,
    @Param('account_id', ParseUUIDPipe) account_id: string,
  ): Promise<{ message: string }> {
    return this.service.deleteAccount(req.user.id, account_id);
  }
}
