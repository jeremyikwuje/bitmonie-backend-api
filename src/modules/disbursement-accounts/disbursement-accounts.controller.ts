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
import type { User } from '@prisma/client';
import { SessionGuard } from '@/common/guards/session.guard';
import { KycTierGuard } from '@/common/guards/kyc-tier.guard';
import { RequiresKyc } from '@/common/decorators/requires-kyc.decorator';
import { DisbursementAccountsService } from './disbursement-accounts.service';
import { AddDisbursementAccountDto } from './dto/add-disbursement-account.dto';
import { SetDefaultDisbursementAccountDto } from './dto/set-default-disbursement-account.dto';

type AuthRequest = Request & { user: User };

@ApiTags('Disbursement Accounts')
@ApiBearerAuth()
@UseGuards(SessionGuard, KycTierGuard)
@RequiresKyc(1)
@Controller('disbursement-accounts')
export class DisbursementAccountsController {
  constructor(private readonly service: DisbursementAccountsService) {}

  @Post()
  @ApiOperation({ summary: 'Add a disbursement account' })
  @ApiResponse({ status: 201, description: 'Account added' })
  @ApiResponse({ status: 400, description: 'Max accounts reached' })
  @ApiResponse({ status: 403, description: 'KYC required' })
  @ApiResponse({ status: 422, description: 'Name mismatch' })
  async addAccount(
    @Req() req: AuthRequest,
    @Body() dto: AddDisbursementAccountDto,
  ): Promise<{ id: string; message: string }> {
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
  @ApiResponse({ status: 200, description: 'Account deleted' })
  @ApiResponse({ status: 400, description: 'Cannot delete sole default account' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  async deleteAccount(
    @Req() req: AuthRequest,
    @Param('account_id', ParseUUIDPipe) account_id: string,
  ): Promise<{ message: string }> {
    return this.service.deleteAccount(req.user.id, account_id);
  }
}
