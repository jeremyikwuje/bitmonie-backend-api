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
import { TransactionPinService } from './transaction-pin.service';
import { SignupDto } from './dto/signup.dto';
import { EmailOnlyDto } from './dto/email-only.dto';
import { VerifyLoginOtpDto } from './dto/verify-login-otp.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { Verify2faDto } from './dto/verify-2fa.dto';
import {
  SetTransactionPinDto,
  ChangeTransactionPinDto,
  DisableTransactionPinDto,
} from './dto/set-transaction-pin.dto';
import { SessionGuard } from '@/common/guards/session.guard';
import { CurrentUser, type AuthenticatedUser } from '@/common/decorators/current-user.decorator';
import { SESSION_TTL_SEC } from '@/common/constants';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth_service: AuthService,
    private readonly transaction_pin_service: TransactionPinService,
  ) {}

  // ── Signup + email verification ─────────────────────────────────────────────

  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new account (passwordless)' })
  @ApiResponse({ status: 201, description: 'If the email is new, an account is created. A verification OTP is sent either way (200-on-no-leak).' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  async signup(
    @Body() dto: SignupDto,
    @Req() req: Request,
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
  async resendVerification(@Body() dto: EmailOnlyDto): Promise<{ message: string }> {
    await this.auth_service.resendVerificationEmail(dto.email);
    return { message: 'If your email is registered and unverified, a new code has been sent.' };
  }

  // ── Passwordless login ──────────────────────────────────────────────────────
  //
  // Two-step flow: request-otp emails a code; verify-otp consumes it and
  // mints a session. TOTP is intentionally NOT consulted at login (single
  // factor by design — see §5.4a in CLAUDE.md). Sensitive transactional ops
  // step up via the transaction PIN or TOTP, never via the login itself.

  @Post('login/request-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request a login OTP for an email address' })
  @ApiResponse({ status: 200, description: 'OTP sent if account exists and is verified (always 200 to avoid leaking account existence)' })
  async requestLoginOtp(@Body() dto: EmailOnlyDto): Promise<{ message: string }> {
    await this.auth_service.requestLoginOtp(dto.email);
    return { message: 'If that email is registered and verified, a login code has been sent.' };
  }

  @Post('login/verify-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Submit a login OTP to mint a session' })
  @ApiResponse({ status: 200, description: 'Logged in — session cookie set + token in body for mobile (Authorization: Bearer <token>)' })
  @ApiResponse({ status: 422, description: 'OTP expired or invalid' })
  async verifyLoginOtp(
    @Body() dto: VerifyLoginOtpDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ message: string; token: string; expires_in: number }> {
    const { token } = await this.auth_service.verifyLoginOtp(
      dto,
      req.ip,
      req.headers['user-agent'],
    );

    res.cookie('session', token, sessionCookieOptions(SESSION_TTL_SEC * 1_000));

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

    res.clearCookie('session', sessionCookieOptions());
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
    res.clearCookie('session', sessionCookieOptions());
    return { message: 'All sessions ended.' };
  }

  // ── 2FA (TOTP) ──────────────────────────────────────────────────────────────

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

  // ── Transaction PIN ────────────────────────────────────────────────────────
  //
  // Opt-in second factor for sensitive transactional ops (currently:
  // changing the collateral release address). Never consulted at login.
  // Either a PIN OR TOTP must be set for the user to perform a sensitive
  // op — see CLAUDE.md §5.4a. The web client should subtly nudge the user
  // to set one after first login (transaction_pin_set on /auth/me).

  @Post('transaction-pin/request-set-otp')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard)
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Email an OTP for setting a transaction PIN' })
  @ApiResponse({ status: 200, description: 'OTP sent' })
  @ApiResponse({ status: 409, description: 'PIN already set — use change instead' })
  async requestSetTransactionPinOtp(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ message: string }> {
    await this.transaction_pin_service.requestSetOtp(user.id);
    return { message: 'A code to set your transaction PIN has been sent to your email.' };
  }

  @Post('transaction-pin/set')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard)
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Set a transaction PIN for the first time' })
  @ApiResponse({ status: 200, description: 'PIN set' })
  @ApiResponse({ status: 409, description: 'PIN already set' })
  @ApiResponse({ status: 422, description: 'OTP expired or invalid' })
  async setTransactionPin(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SetTransactionPinDto,
  ): Promise<{ message: string }> {
    await this.transaction_pin_service.setPin(user.id, dto);
    return { message: 'Transaction PIN set.' };
  }

  @Post('transaction-pin/request-change-otp')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard)
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Email an OTP for changing the transaction PIN' })
  @ApiResponse({ status: 200, description: 'OTP sent' })
  @ApiResponse({ status: 409, description: 'PIN not set — call set-otp instead' })
  async requestChangeTransactionPinOtp(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ message: string }> {
    await this.transaction_pin_service.requestChangeOtp(user.id);
    return { message: 'A code to change your transaction PIN has been sent to your email.' };
  }

  @Post('transaction-pin/change')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard)
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Change the transaction PIN (requires current PIN + email OTP)' })
  @ApiResponse({ status: 200, description: 'PIN changed' })
  @ApiResponse({ status: 401, description: 'Current PIN incorrect' })
  @ApiResponse({ status: 422, description: 'OTP expired or invalid' })
  async changeTransactionPin(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangeTransactionPinDto,
  ): Promise<{ message: string }> {
    await this.transaction_pin_service.changePin(user.id, dto);
    return { message: 'Transaction PIN changed.' };
  }

  @Post('transaction-pin/request-disable-otp')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard)
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Email an OTP for disabling the transaction PIN' })
  @ApiResponse({ status: 200, description: 'OTP sent' })
  @ApiResponse({ status: 409, description: 'PIN not set' })
  async requestDisableTransactionPinOtp(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ message: string }> {
    await this.transaction_pin_service.requestDisableOtp(user.id);
    return { message: 'A code to disable your transaction PIN has been sent to your email.' };
  }

  @Post('transaction-pin/disable')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard)
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Disable the transaction PIN (current PIN OR TOTP, plus email OTP)' })
  @ApiResponse({ status: 200, description: 'PIN disabled' })
  @ApiResponse({ status: 401, description: 'PIN/TOTP rejected' })
  @ApiResponse({ status: 422, description: 'OTP expired or invalid' })
  async disableTransactionPin(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DisableTransactionPinDto,
  ): Promise<{ message: string }> {
    await this.transaction_pin_service.disablePin(user.id, dto);
    return { message: 'Transaction PIN disabled.' };
  }

  // ── /me ────────────────────────────────────────────────────────────────────

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
    transaction_pin_set: boolean;
    created_at: Date;
  } {
    return {
      id:                  user.id,
      email:               user.email,
      email_verified:      user.email_verified,
      totp_enabled:        user.totp_enabled,
      // Boolean derivation from the hash — never leak the hash itself.
      transaction_pin_set: user.transaction_pin_hash !== null,
      created_at:          user.created_at,
    };
  }
}

// Single source of truth for the session-cookie attributes. login (set) and
// the two logout paths (clear) MUST agree on every attribute or browsers
// will silently keep the original cookie around after logout.
//
//   sameSite='none' + secure=true  → required for cross-site SPA auth
//     (e.g. localhost:5173 / web.bitmonie.co frontend → api.bitmonie.co API).
//     'strict' / 'lax' would block the cookie on cross-site fetches.
//   sameSite='lax' + secure=false  → dev fallback for localhost:port-to-port,
//     where 'none' would force HTTPS that we don't have locally.
//
// CSRF: still mitigated by HttpOnly + ALLOWED_ORIGIN allowlist (preflight
// gates which origins can even attempt credentialed requests) + the
// Idempotency-Key requirement on every write. Add a CSRF token if the
// trust boundary later needs it.
function sessionCookieOptions(maxAge?: number) {
  const is_dev = process.env.NODE_ENV === 'development';
  return {
    httpOnly: true,
    secure: !is_dev,
    sameSite: (is_dev ? 'lax' : 'none') as 'lax' | 'none',
    path: '/',
    ...(maxAge !== undefined ? { maxAge } : {}),
  };
}
