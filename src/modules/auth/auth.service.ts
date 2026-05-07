import { Injectable, Inject, HttpStatus } from '@nestjs/common';
import type Redis from 'ioredis';
import { generateSecret, verify as totpVerify, generateURI } from 'otplib';
import * as QRCode from 'qrcode';
import { randomInt, createHash, timingSafeEqual } from 'crypto';
import { PrismaService } from '@/database/prisma.service';
import { CryptoService } from '@/common/crypto/crypto.service';
import { REDIS_CLIENT } from '@/database/redis.module';
import { SessionService } from './session.service';
import {
  EMAIL_PROVIDER,
  type EmailProvider,
  type OtpPurpose,
} from './email.provider.interface';
import type { SignupDto } from './dto/signup.dto';
import type { VerifyEmailDto } from './dto/verify-email.dto';
import type { VerifyLoginOtpDto } from './dto/verify-login-otp.dto';
import type { Verify2faDto } from './dto/verify-2fa.dto';
import {
  AuthInvalidCredentialsException,
  AuthOtpExpiredException,
  AuthOtpMaxAttemptsException,
  Auth2faRequiredException,
  BitmonieException,
} from '@/common/errors/bitmonie.errors';

const OTP_TTL_SEC = 900;
const OTP_MAX_ATTEMPTS = 5;
const OTP_LENGTH = 6;
const APP_NAME = 'Bitmonie';

// All scoped OTP purposes share the same Redis key/attempts discipline.
// Email-only OTPs (verify, login) key on the email; loan/PIN-scoped OTPs
// key on user_id (+ optional resource_id) — see scopedOtpKey.
type EmailScopedPurpose = Extract<OtpPurpose, 'verify' | 'login'>;

function emailOtpKey(purpose: EmailScopedPurpose, email: string): string {
  return `auth:otp:${purpose}:${email}`;
}

function emailOtpAttemptsKey(purpose: EmailScopedPurpose, email: string): string {
  return `auth:otp_attempts:${purpose}:${email}`;
}

function hashOtp(otp: string): string {
  return createHash('sha256').update(otp).digest('hex');
}

function safeCompareOtp(otp: string, stored_hash: string): boolean {
  const input_hash = Buffer.from(hashOtp(otp), 'hex');
  const expected = Buffer.from(stored_hash, 'hex');
  if (input_hash.length !== expected.length) return false;
  return timingSafeEqual(input_hash, expected);
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly session_service: SessionService,
    private readonly crypto_service: CryptoService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(EMAIL_PROVIDER) private readonly email_provider: EmailProvider,
  ) {}

  // ── Signup + email verification ────────────────────────────────────────────

  async signup(dto: SignupDto, ip?: string, user_agent?: string): Promise<void> {
    void ip;
    void user_agent;

    const email = dto.email.toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });

    // Always send the OTP (or pretend to) so signup never leaks whether an
    // email is registered. If it exists and is verified, we silently no-op
    // — the normal path for that user is /login, not /signup.
    if (existing) {
      if (!existing.email_verified) await this.sendEmailOtp('verify', email);
      return;
    }

    await this.prisma.user.create({
      data: { email, email_verified: false, country: 'NG' },
    });
    await this.sendEmailOtp('verify', email);
  }

  async verifyEmail(dto: VerifyEmailDto): Promise<void> {
    const email = dto.email.toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user) throw new AuthOtpExpiredException();

    if (user.email_verified) {
      throw new BitmonieException(
        'AUTH_EMAIL_ALREADY_VERIFIED',
        'Email address has already been verified.',
        HttpStatus.CONFLICT,
      );
    }

    await this.consumeEmailOtp('verify', email, dto.otp);
    await this.prisma.user.update({ where: { id: user.id }, data: { email_verified: true } });
  }

  async resendVerificationEmail(email: string): Promise<void> {
    const normalised = email.toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email: normalised } });
    if (!user || user.email_verified) return;
    await this.sendEmailOtp('verify', normalised);
  }

  // ── Passwordless login ─────────────────────────────────────────────────────
  //
  // Two-step: request-otp emails a code; verify-otp consumes it and mints a
  // session. TOTP is NOT consulted at login by design — see the security
  // model in CLAUDE.md §5.4a and the rationale in docs/tdd.md (auth section).

  async requestLoginOtp(email: string): Promise<void> {
    const normalised = email.toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email: normalised } });
    // Never leak whether the email exists. We also skip unverified users so
    // signup-then-immediately-login forces them through verify-email first.
    if (!user || !user.email_verified) return;
    await this.sendEmailOtp('login', normalised);
  }

  async verifyLoginOtp(
    dto: VerifyLoginOtpDto,
    ip?: string,
    user_agent?: string,
  ): Promise<{ token: string }> {
    const email = dto.email.toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new AuthOtpExpiredException();

    // Defense in depth: an attacker shouldn't be able to log into an
    // unverified account by guessing OTPs of the verification flow. The
    // login OTP is independent (different Redis key), so this is mostly
    // belt-and-braces — but we still enforce email_verified as a hard gate.
    if (!user.email_verified) {
      throw new BitmonieException(
        'AUTH_EMAIL_NOT_VERIFIED',
        'Please verify your email address before logging in.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    await this.consumeEmailOtp('login', email, dto.otp);

    const token = await this.session_service.create({
      user_id:    user.id,
      ip_address: ip,
      user_agent,
    });
    return { token };
  }

  async logout(token: string): Promise<void> {
    const token_hash = createHash('sha256').update(token).digest('hex');
    await this.session_service.destroy(token_hash);
  }

  async logoutAll(user_id: string): Promise<void> {
    await this.session_service.destroyAll(user_id);
  }

  // ── 2FA (TOTP) ─────────────────────────────────────────────────────────────
  //
  // TOTP is OPT-IN and used as a transaction step-up factor (alongside the
  // transaction PIN) — never at login. setup → confirm activates it; disable
  // requires the user to prove possession of the current code (no password
  // exists to gate it anymore).

  async setup2fa(user_id: string): Promise<{ secret: string; qr_code_uri: string; otpauth_url: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: user_id } });

    if (user.totp_enabled) {
      throw new BitmonieException('AUTH_2FA_ALREADY_ENABLED', '2FA is already enabled.', HttpStatus.CONFLICT);
    }

    const secret = generateSecret();
    const encrypted_secret = this.crypto_service.encrypt(secret);
    const otpauth_url = generateURI({ issuer: APP_NAME, label: user.email, secret });
    const qr_code_uri = await QRCode.toDataURL(otpauth_url);

    await this.prisma.user.update({
      where: { id: user_id },
      data: { totp_secret: encrypted_secret, totp_enabled: false },
    });

    return { secret, qr_code_uri, otpauth_url };
  }

  async confirm2fa(user_id: string, dto: Verify2faDto): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: user_id } });

    if (user.totp_enabled) {
      throw new BitmonieException('AUTH_2FA_ALREADY_ENABLED', '2FA is already enabled.', HttpStatus.CONFLICT);
    }

    if (!user.totp_secret) {
      throw new BitmonieException(
        'AUTH_2FA_SETUP_REQUIRED',
        'Call GET /auth/2fa/setup first to get your TOTP secret.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const secret = this.crypto_service.decrypt(user.totp_secret);
    const result = await totpVerify({ secret, token: dto.totp_code });
    if (!result.valid) throw new AuthInvalidCredentialsException();

    await this.prisma.user.update({ where: { id: user_id }, data: { totp_enabled: true } });
  }

  async disable2fa(user_id: string, dto: Verify2faDto): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: user_id } });

    if (!user.totp_enabled || !user.totp_secret) {
      throw new BitmonieException('AUTH_2FA_NOT_ENABLED', '2FA is not enabled.', HttpStatus.BAD_REQUEST);
    }

    const secret = this.crypto_service.decrypt(user.totp_secret);
    const result = await totpVerify({ secret, token: dto.totp_code });
    if (!result.valid) throw new AuthInvalidCredentialsException();

    await this.prisma.user.update({
      where: { id: user_id },
      data: { totp_enabled: false, totp_secret: null },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step-up verification — release-address change (email OTP scoped to loan)
  //
  // Used by LoansService.setReleaseAddress when the customer is CHANGING an
  // existing release address (NULL→value first-set is exempt). The OTP key
  // is scoped to (user_id, loan_id) so a code sent for one loan can't be
  // replayed against another. The customer's email is looked up here so
  // callers don't need to pass it (avoids accidental misuse).
  // ─────────────────────────────────────────────────────────────────────────

  async sendReleaseAddressChangeOtp(user_id: string, loan_id: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where:  { id: user_id },
      select: { email: true },
    });
    const otp = this.generateOtp();
    const key = scopedOtpKey('release_address_change', user_id, loan_id);
    await this.redis.set(key, hashOtp(otp), 'EX', OTP_TTL_SEC);
    await this.redis.del(scopedOtpAttemptsKey('release_address_change', user_id, loan_id));
    await this.email_provider.sendOtp({ to: user.email, otp, purpose: 'release_address_change' });
  }

  async consumeReleaseAddressChangeOtp(user_id: string, loan_id: string, otp: string): Promise<void> {
    return this.consumeScopedOtp('release_address_change', user_id, otp, loan_id);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Transaction-PIN OTPs — scoped to user_id only (no resource id needed
  // because PINs are user-global). TransactionPinService delegates email
  // delivery here so we keep all OTP discipline (TTL, attempts, hashing) in
  // one place.
  // ─────────────────────────────────────────────────────────────────────────

  async sendTransactionPinOtp(
    user_id: string,
    purpose: 'transaction_pin_set' | 'transaction_pin_change' | 'transaction_pin_disable',
  ): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where:  { id: user_id },
      select: { email: true },
    });
    const otp = this.generateOtp();
    await this.redis.set(scopedOtpKey(purpose, user_id), hashOtp(otp), 'EX', OTP_TTL_SEC);
    await this.redis.del(scopedOtpAttemptsKey(purpose, user_id));
    await this.email_provider.sendOtp({ to: user.email, otp, purpose });
  }

  async consumeTransactionPinOtp(
    user_id: string,
    purpose: 'transaction_pin_set' | 'transaction_pin_change' | 'transaction_pin_disable',
    otp: string,
  ): Promise<void> {
    return this.consumeScopedOtp(purpose, user_id, otp);
  }

  // Verifies a TOTP code against the user's stored secret. Caller is
  // expected to have already checked user.totp_enabled — if not enabled,
  // throws Auth2faRequiredException (treated as configuration error since
  // step-up flows shouldn't request TOTP from non-2FA users). Wrong code
  // throws AuthInvalidCredentialsException.
  async verifyTotpForUser(user_id: string, totp_code: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where:  { id: user_id },
      select: { totp_enabled: true, totp_secret: true },
    });
    if (!user.totp_enabled || !user.totp_secret) {
      throw new Auth2faRequiredException();
    }
    const secret = this.crypto_service.decrypt(user.totp_secret);
    const result = await totpVerify({ secret, token: totp_code });
    if (!result.valid) throw new AuthInvalidCredentialsException();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private generateOtp(): string {
    return String(randomInt(0, 1_000_000)).padStart(OTP_LENGTH, '0');
  }

  private async sendEmailOtp(purpose: EmailScopedPurpose, email: string): Promise<void> {
    const otp = this.generateOtp();
    await this.redis.set(emailOtpKey(purpose, email), hashOtp(otp), 'EX', OTP_TTL_SEC);
    await this.redis.del(emailOtpAttemptsKey(purpose, email));
    await this.email_provider.sendOtp({ to: email, otp, purpose });
  }

  private async consumeEmailOtp(
    purpose: EmailScopedPurpose,
    email: string,
    otp: string,
  ): Promise<void> {
    const attempts_key = emailOtpAttemptsKey(purpose, email);
    const attempts_raw = await this.redis.get(attempts_key);
    const attempts = attempts_raw ? parseInt(attempts_raw, 10) : 0;

    if (attempts >= OTP_MAX_ATTEMPTS) throw new AuthOtpMaxAttemptsException();

    const stored_hash = await this.redis.get(emailOtpKey(purpose, email));
    if (!stored_hash) throw new AuthOtpExpiredException();

    await this.redis.incr(attempts_key);
    await this.redis.expire(attempts_key, OTP_TTL_SEC);

    if (!safeCompareOtp(otp, stored_hash)) throw new AuthOtpExpiredException();

    await this.redis.del(emailOtpKey(purpose, email));
    await this.redis.del(attempts_key);
  }

  private async consumeScopedOtp(
    purpose: Exclude<OtpPurpose, EmailScopedPurpose>,
    user_id: string,
    otp: string,
    resource_id?: string,
  ): Promise<void> {
    const attempts_key = scopedOtpAttemptsKey(purpose, user_id, resource_id);
    const attempts_raw = await this.redis.get(attempts_key);
    const attempts = attempts_raw ? parseInt(attempts_raw, 10) : 0;
    if (attempts >= OTP_MAX_ATTEMPTS) throw new AuthOtpMaxAttemptsException();

    const stored_hash = await this.redis.get(scopedOtpKey(purpose, user_id, resource_id));
    if (!stored_hash) throw new AuthOtpExpiredException();

    await this.redis.incr(attempts_key);
    await this.redis.expire(attempts_key, OTP_TTL_SEC);

    if (!safeCompareOtp(otp, stored_hash)) throw new AuthOtpExpiredException();

    await this.redis.del(scopedOtpKey(purpose, user_id, resource_id));
    await this.redis.del(attempts_key);
  }
}

function scopedOtpKey(
  purpose: Exclude<OtpPurpose, EmailScopedPurpose>,
  user_id: string,
  resource_id?: string,
): string {
  const tail = resource_id ? `:${resource_id}` : '';
  return `auth:otp:${purpose}:${user_id}${tail}`;
}

function scopedOtpAttemptsKey(
  purpose: Exclude<OtpPurpose, EmailScopedPurpose>,
  user_id: string,
  resource_id?: string,
): string {
  const tail = resource_id ? `:${resource_id}` : '';
  return `auth:otp_attempts:${purpose}:${user_id}${tail}`;
}
