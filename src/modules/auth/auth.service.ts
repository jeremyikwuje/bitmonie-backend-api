import { Injectable, Inject, HttpStatus } from '@nestjs/common';
import type Redis from 'ioredis';
import * as argon2 from 'argon2';
import { generateSecret, verify as totpVerify, generateURI } from 'otplib';
import * as QRCode from 'qrcode';
import { randomInt, createHash, timingSafeEqual } from 'crypto';
import { PrismaService } from '@/database/prisma.service';
import { CryptoService } from '@/common/crypto/crypto.service';
import { REDIS_CLIENT } from '@/database/redis.module';
import { SessionService } from './session.service';
import { EMAIL_PROVIDER, type EmailProvider } from './email.provider.interface';
import type { SignupDto } from './dto/signup.dto';
import type { LoginDto } from './dto/login.dto';
import type { VerifyEmailDto } from './dto/verify-email.dto';
import type { ForgotPasswordDto } from './dto/forgot-password.dto';
import type { ResetPasswordDto } from './dto/reset-password.dto';
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

function otpKey(purpose: 'verify' | 'reset', email: string): string {
  return `auth:otp:${purpose}:${email}`;
}

function otpAttemptsKey(purpose: 'verify' | 'reset', email: string): string {
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

  async signup(dto: SignupDto, ip?: string, user_agent?: string): Promise<void> {
    void ip;
    void user_agent;

    const email = dto.email.toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });

    if (existing) {
      await this.sendEmailVerificationOtp(email);
      return;
    }

    const password_hash = await argon2.hash(dto.password);
    await this.prisma.user.create({
      data: { email, password_hash, email_verified: false },
    });
    await this.sendEmailVerificationOtp(email);
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

    await this.consumeOtp('verify', email, dto.otp);
    await this.prisma.user.update({ where: { id: user.id }, data: { email_verified: true } });
  }

  async login(dto: LoginDto, ip?: string, user_agent?: string): Promise<{ token: string }> {
    const email = dto.email.toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user) throw new AuthInvalidCredentialsException();

    const password_ok = await argon2.verify(user.password_hash, dto.password);
    if (!password_ok) throw new AuthInvalidCredentialsException();

    if (!user.email_verified) {
      throw new BitmonieException(
        'AUTH_EMAIL_NOT_VERIFIED',
        'Please verify your email address before logging in.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    if (user.totp_enabled) {
      if (!dto.totp_code) throw new Auth2faRequiredException();
      const secret = user.totp_secret ? this.crypto_service.decrypt(user.totp_secret) : null;
      if (!secret) throw new AuthInvalidCredentialsException();
      const result = await totpVerify({ secret, token: dto.totp_code });
      if (!result.valid) throw new AuthInvalidCredentialsException();
    }

    const token = await this.session_service.create({ user_id: user.id, ip_address: ip, user_agent });
    return { token };
  }

  async logout(token: string): Promise<void> {
    const token_hash = createHash('sha256').update(token).digest('hex');
    await this.session_service.destroy(token_hash);
  }

  async logoutAll(user_id: string): Promise<void> {
    await this.session_service.destroyAll(user_id);
  }

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

  async forgotPassword(dto: ForgotPasswordDto): Promise<void> {
    const email = dto.email.toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) return; // never leak account existence
    await this.sendPasswordResetOtp(email);
  }

  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    const email = dto.email.toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new AuthOtpExpiredException();

    await this.consumeOtp('reset', email, dto.otp);

    const password_hash = await argon2.hash(dto.new_password);
    await this.prisma.user.update({ where: { id: user.id }, data: { password_hash } });
    await this.session_service.destroyAll(user.id);
  }

  async resendVerificationEmail(email: string): Promise<void> {
    const normalised = email.toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email: normalised } });
    if (!user || user.email_verified) return;
    await this.sendEmailVerificationOtp(normalised);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private generateOtp(): string {
    return String(randomInt(0, 1_000_000)).padStart(OTP_LENGTH, '0');
  }

  private async sendEmailVerificationOtp(email: string): Promise<void> {
    const otp = this.generateOtp();
    await this.redis.set(otpKey('verify', email), hashOtp(otp), 'EX', OTP_TTL_SEC);
    await this.redis.del(otpAttemptsKey('verify', email));
    await this.email_provider.sendOtp({ to: email, otp, purpose: 'verify' });
  }

  private async sendPasswordResetOtp(email: string): Promise<void> {
    const otp = this.generateOtp();
    await this.redis.set(otpKey('reset', email), hashOtp(otp), 'EX', OTP_TTL_SEC);
    await this.redis.del(otpAttemptsKey('reset', email));
    await this.email_provider.sendOtp({ to: email, otp, purpose: 'reset' });
  }

  private async consumeOtp(purpose: 'verify' | 'reset', email: string, otp: string): Promise<void> {
    const attempts_key = otpAttemptsKey(purpose, email);
    const attempts_raw = await this.redis.get(attempts_key);
    const attempts = attempts_raw ? parseInt(attempts_raw, 10) : 0;

    if (attempts >= OTP_MAX_ATTEMPTS) throw new AuthOtpMaxAttemptsException();

    const stored_hash = await this.redis.get(otpKey(purpose, email));
    if (!stored_hash) throw new AuthOtpExpiredException();

    await this.redis.incr(attempts_key);
    await this.redis.expire(attempts_key, OTP_TTL_SEC);

    if (!safeCompareOtp(otp, stored_hash)) throw new AuthOtpExpiredException();

    await this.redis.del(otpKey(purpose, email));
    await this.redis.del(attempts_key);
  }
}
