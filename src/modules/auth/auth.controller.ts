import {
  Controller,
  Post,
  Get,
  Body,
  Res,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiCookieAuth,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { Verify2faDto } from './dto/verify-2fa.dto';
import { SessionGuard } from '@/common/guards/session.guard';
import { CurrentUser, type AuthenticatedUser } from '@/common/decorators/current-user.decorator';
import { SESSION_TTL_SEC } from '@/common/constants';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth_service: AuthService) {}

  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new account' })
  @ApiResponse({ status: 201, description: 'If the email is new, an account is created; a verification OTP is sent either way' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  async signup(
    @Body() dto: SignupDto,
    @Req() req: Request,
    @Res({ passthrough: true }) _res: Response,
  ): Promise<{ message: string }> {
    await this.auth_service.signup(
      dto,
      req.ip,
      req.headers['user-agent'],
    );
    return { message: 'If this email is new, your account has been created. Check your inbox for a verification code.' };
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify email address with OTP' })
  @ApiResponse({ status: 200, description: 'Email verified' })
  @ApiResponse({ status: 422, description: 'OTP expired or invalid' })
  async verifyEmail(@Body() dto: VerifyEmailDto): Promise<{ message: string }> {
    await this.auth_service.verifyEmail(dto);
    return { message: 'Email verified.' };
  }

  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resend email verification OTP' })
  @ApiResponse({ status: 200, description: 'OTP resent if account exists and is unverified' })
  async resendVerification(@Body() dto: ForgotPasswordDto): Promise<{ message: string }> {
    await this.auth_service.resendVerificationEmail(dto.email);
    return { message: 'If your email is registered and unverified, a new code has been sent.' };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password (+ optional TOTP)' })
  @ApiResponse({ status: 200, description: 'Logged in — session cookie set + token in body for mobile (Authorization: Bearer <token>)' })
  @ApiResponse({ status: 401, description: 'Invalid credentials or 2FA required' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ message: string; token: string; expires_in: number }> {
    const { token } = await this.auth_service.login(
      dto,
      req.ip,
      req.headers['user-agent'],
    );

    res.cookie('session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV !== 'development',
      sameSite: 'strict',
      maxAge: SESSION_TTL_SEC * 1_000,
      path: '/',
    });

    return { message: 'Logged in.', token, expires_in: SESSION_TTL_SEC };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard)
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'End current session' })
  @ApiResponse({ status: 200, description: 'Logged out' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ message: string }> {
    const token = (req as Request & { cookies?: Record<string, string> }).cookies?.session ?? '';
    await this.auth_service.logout(token);

    res.clearCookie('session', { path: '/' });
    return { message: 'Logged out.' };
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard)
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'End all sessions for the current user' })
  @ApiResponse({ status: 200, description: 'All sessions invalidated' })
  async logoutAll(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ message: string }> {
    await this.auth_service.logoutAll(user.id);
    res.clearCookie('session', { path: '/' });
    return { message: 'All sessions ended.' };
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request a password reset OTP' })
  @ApiResponse({ status: 200, description: 'OTP sent if account exists' })
  async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<{ message: string }> {
    await this.auth_service.forgotPassword(dto);
    return { message: 'If that email is registered, a reset code has been sent.' };
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password using OTP' })
  @ApiResponse({ status: 200, description: 'Password reset — all sessions invalidated' })
  @ApiResponse({ status: 422, description: 'OTP expired or invalid' })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<{ message: string }> {
    await this.auth_service.resetPassword(dto);
    return { message: 'Password reset. Please log in with your new password.' };
  }

  @Get('2fa/setup')
  @UseGuards(SessionGuard)
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Get TOTP secret and QR code for 2FA setup' })
  @ApiResponse({ status: 200, description: 'TOTP secret and QR code URI' })
  @ApiResponse({ status: 409, description: '2FA already enabled' })
  async setup2fa(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ otpauth_url: string; qr_code_uri: string }> {
    const result = await this.auth_service.setup2fa(user.id);
    return { otpauth_url: result.otpauth_url, qr_code_uri: result.qr_code_uri };
  }

  @Post('2fa/confirm')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard)
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Confirm TOTP code to activate 2FA' })
  @ApiResponse({ status: 200, description: '2FA enabled' })
  @ApiResponse({ status: 401, description: 'Invalid TOTP code' })
  async confirm2fa(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: Verify2faDto,
  ): Promise<{ message: string }> {
    await this.auth_service.confirm2fa(user.id, dto);
    return { message: '2FA enabled.' };
  }

  @Post('2fa/disable')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard)
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Disable 2FA by confirming current TOTP code' })
  @ApiResponse({ status: 200, description: '2FA disabled' })
  @ApiResponse({ status: 401, description: 'Invalid TOTP code' })
  async disable2fa(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: Verify2faDto,
  ): Promise<{ message: string }> {
    await this.auth_service.disable2fa(user.id, dto);
    return { message: '2FA disabled.' };
  }

  @Get('me')
  @UseGuards(SessionGuard)
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Get current authenticated user' })
  @ApiResponse({ status: 200, description: 'Current user profile' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  getMe(@CurrentUser() user: AuthenticatedUser): {
    id: string;
    email: string;
    email_verified: boolean;
    totp_enabled: boolean;
    created_at: Date;
  } {
    return {
      id: user.id,
      email: user.email,
      email_verified: user.email_verified,
      totp_enabled: user.totp_enabled,
      created_at: user.created_at,
    };
  }
}
