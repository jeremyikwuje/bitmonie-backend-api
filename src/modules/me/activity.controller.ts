import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SessionGuard } from '@/common/guards/session.guard';
import { CurrentUser, type AuthenticatedUser } from '@/common/decorators/current-user.decorator';
import { ActivityService } from './activity.service';
import { ActivityPageResponseDto } from './dto/activity-page-response.dto';
import { ActivityQueryDto } from './dto/activity-query.dto';

@ApiTags('activity')
@ApiBearerAuth()
@ApiCookieAuth('session')
@UseGuards(SessionGuard)
@Controller('activity')
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get()
  @ApiOperation({
    summary: "Cursor-paginated money-movement activity feed for the user",
    description:
      'Sources: loan_status_logs (every loan lifecycle event) + inflows (unmatched only). ' +
      'Auth events (login, password change, 2FA) are deliberately excluded — those live ' +
      'under Security in the avatar sheet. Sort is occurred_at DESC, id DESC.',
  })
  @ApiResponse({ status: 200, type: ActivityPageResponseDto })
  @ApiResponse({ status: 400, description: 'Malformed cursor' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async getActivity(
    @CurrentUser() user: AuthenticatedUser,
    @Query() dto: ActivityQueryDto,
  ): Promise<ActivityPageResponseDto> {
    return this.activity.getPage(user.id, dto.cursor, dto.limit ?? 20);
  }
}
