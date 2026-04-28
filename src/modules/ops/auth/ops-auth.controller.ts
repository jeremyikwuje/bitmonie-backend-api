import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { OpsAuthService } from './ops-auth.service';
import { OpsLoginDto } from './dto/ops-login.dto';
import { OpsVerify2faDto } from './dto/ops-verify-2fa.dto';
import { OpsEnrol2faDto } from './dto/ops-enrol-2fa.dto';
import { OpsStartEnrolmentDto } from './dto/ops-start-enrolment.dto';
import { OpsGuard } from '@/common/guards/ops-session.guard';
import {
  CurrentOpsUser,
  type AuthenticatedOpsUser,
} from '@/common/decorators/current-ops-user.decorator';
import {
  OpsInvalidCredentialsException,
  OpsTwoFactorRequiredException,
} from '@/common/errors/bitmonie.errors';
import { OPS_SESSION_TTL_SEC } from '@/common/constants';

const OPS_COOKIE_NAME = 'ops_session';

@ApiTags('ops-auth')
@Controller('ops/auth')
export class OpsAuthController {
  constructor(private readonly ops_auth_service: OpsAuthService) {}

  // Step 1: email + password. The service always throws on the happy path —
  // OpsTwoFactorRequiredException carries the challenge_id, which we translate
  // to a 202 body. Enrolment-required and credential errors flow through
  // GlobalExceptionFilter unchanged (403 / 401).
  @Post('login')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiOperation({ summary: 'Ops login step 1: email + password' })
  @ApiResponse({ status: 202, description: 'Credentials valid; submit challenge_id + TOTP to /verify-2fa' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  @ApiResponse({ status: 403, description: 'Account disabled, or first-time login (OPS_2FA_ENROLMENT_REQUIRED)' })
  async login(@Body() dto: OpsLoginDto): Promise<{ challenge_id: string }> {
    try {
      await this.ops_auth_service.login({ email: dto.email, password: dto.password });
    } catch (err) {
      if (err instanceof OpsTwoFactorRequiredException) {
        const challenge_id = err.details?.[0]?.issue ?? '';
        return { challenge_id };
      }
      throw err;
    }
    // Service.login() is typed Promise<never> — it always throws. If we get
    // here, treat it as a credentials failure rather than silently 202'ing.
    throw new OpsInvalidCredentialsException();
  }

  @Post('verify-2fa')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiOperation({ summary: 'Ops login step 2: redeem challenge_id + TOTP for an ops_session cookie' })
  @ApiResponse({ status: 200, description: 'Authenticated — ops_session cookie set' })
  @ApiResponse({ status: 401, description: 'Challenge stale or TOTP invalid' })
  async verify2fa(
    @Body() dto: OpsVerify2faDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ message: string; token: string; expires_in: number }> {
    const { token } = await this.ops_auth_service.verifyTwoFactor({
      challenge_id: dto.challenge_id,
      totp_code: dto.totp_code,
      ip_address: req.ip,
      user_agent: req.headers['user-agent'],
    });

    res.cookie(OPS_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV !== 'development',
      sameSite: 'strict',
      maxAge: OPS_SESSION_TTL_SEC * 1_000,
      path: '/',
    });

    return { message: 'Logged in.', token, expires_in: OPS_SESSION_TTL_SEC };
  }

  @Post('start-enrolment')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiOperation({ summary: 'First-time ops enrolment: redeem enrolment_token for a fresh TOTP secret + QR code' })
  @ApiResponse({ status: 200, description: 'TOTP secret + QR returned — scan with an authenticator, then call /enrol-2fa' })
  @ApiResponse({ status: 401, description: 'Enrolment token stale or unknown' })
  async startEnrolment(
    @Body() dto: OpsStartEnrolmentDto,
  ): Promise<{ secret: string; qr_code_uri: string; otpauth_url: string }> {
    return this.ops_auth_service.startEnrolment({ enrolment_token: dto.enrolment_token });
  }

  @Post('enrol-2fa')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiOperation({ summary: 'First-time ops enrolment: redeem enrolment_token + TOTP, flips totp_enabled and issues a session' })
  @ApiResponse({ status: 200, description: '2FA enrolled — ops_session cookie set' })
  @ApiResponse({ status: 401, description: 'Enrolment token stale or TOTP invalid' })
  async enrol2fa(
    @Body() dto: OpsEnrol2faDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ message: string; token: string; expires_in: number }> {
    const { token } = await this.ops_auth_service.confirmEnrolment({
      enrolment_token: dto.enrolment_token,
      totp_code: dto.totp_code,
      ip_address: req.ip,
      user_agent: req.headers['user-agent'],
    });

    res.cookie(OPS_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV !== 'development',
      sameSite: 'strict',
      maxAge: OPS_SESSION_TTL_SEC * 1_000,
      path: '/',
    });

    return { message: '2FA enrolled.', token, expires_in: OPS_SESSION_TTL_SEC };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(OpsGuard)
  @ApiCookieAuth(OPS_COOKIE_NAME)
  @ApiOperation({ summary: 'End the current ops session' })
  @ApiResponse({ status: 200, description: 'Session revoked, cookie cleared' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ message: string }> {
    const token =
      (req as Request & { cookies?: Record<string, string> }).cookies?.[OPS_COOKIE_NAME] ??
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : '');

    await this.ops_auth_service.logout(token);
    res.clearCookie(OPS_COOKIE_NAME, { path: '/' });
    return { message: 'Logged out.' };
  }

  @Get('me')
  @UseGuards(OpsGuard)
  @ApiCookieAuth(OPS_COOKIE_NAME)
  @ApiOperation({ summary: 'Current authenticated ops user' })
  @ApiResponse({ status: 200, description: 'Ops user profile' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  getMe(@CurrentOpsUser() ops_user: AuthenticatedOpsUser): {
    id: string;
    email: string;
    full_name: string;
    last_login_at: Date | null;
  } {
    return {
      id: ops_user.id,
      email: ops_user.email,
      full_name: ops_user.full_name,
      last_login_at: ops_user.last_login_at,
    };
  }
}
