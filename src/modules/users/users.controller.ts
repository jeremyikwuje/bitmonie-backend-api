import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SessionGuard } from '@/common/guards/session.guard';
import { CurrentUser, type AuthenticatedUser } from '@/common/decorators/current-user.decorator';
import { UsersService, type UserProfile } from './users.service';

@ApiTags('Users')
@ApiBearerAuth()
@ApiCookieAuth('session')
@UseGuards(SessionGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly users_service: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get the authenticated user\'s full profile' })
  @ApiResponse({ status: 200, description: 'Profile returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  getMe(@CurrentUser() user: AuthenticatedUser): Promise<UserProfile> {
    return this.users_service.getProfile(user.id);
  }
}
