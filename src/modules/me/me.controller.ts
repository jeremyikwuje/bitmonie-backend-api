import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SessionGuard } from '@/common/guards/session.guard';
import { CurrentUser, type AuthenticatedUser } from '@/common/decorators/current-user.decorator';
import { MeService } from './me.service';
import { MeSummaryResponseDto } from './dto/me-summary-response.dto';

@ApiTags('me')
@ApiBearerAuth()
@ApiCookieAuth('session')
@UseGuards(SessionGuard)
@Controller('me')
export class MeController {
  constructor(private readonly me: MeService) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Snapshot for the web app shell — outstanding, attention cards, unmatched inflows',
    description:
      'Read-only aggregate the web client polls on app focus and after every write. ' +
      'Drives the top bar "You owe" line, the Home attention peek-stack, and the ' +
      'Loans-tab inflows banner.',
  })
  @ApiResponse({ status: 200, type: MeSummaryResponseDto })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 422, description: 'Price feed stale (LIQUIDATION_RISK requires fresh SAT/NGN rate)' })
  async getSummary(@CurrentUser() user: AuthenticatedUser): Promise<MeSummaryResponseDto> {
    return this.me.getSummary(user.id);
  }
}
