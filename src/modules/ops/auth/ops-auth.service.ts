import { Injectable, Inject } from '@nestjs/common';
import type Redis from 'ioredis';
import * as argon2 from 'argon2';
import { generateSecret, verify as totpVerify, generateURI } from 'otplib';
import * as QRCode from 'qrcode';
import { randomBytes, createHash } from 'crypto';
import type { OpsUser } from '@prisma/client';
import { PrismaService } from '@/database/prisma.service';
import { CryptoService } from '@/common/crypto/crypto.service';
import { REDIS_CLIENT } from '@/database/redis.module';
import { OpsSessionService } from './ops-session.service';
import {
  REDIS_KEYS,
  OPS_CHALLENGE_TTL_SEC,
  OPS_ENROLMENT_TTL_SEC,
} from '@/common/constants';
import {
  OpsInvalidCredentialsException,
  OpsTwoFactorRequiredException,
  OpsTwoFactorEnrolmentRequiredException,
  OpsTwoFactorInvalidException,
  OpsUserDisabledException,
} from '@/common/errors/bitmonie.errors';

const APP_NAME = 'Bitmonie Ops';

// 32-byte opaque tokens — same shape as session tokens. Long enough to be
// unguessable, short enough to fit comfortably in a JSON body.
function newOpaqueToken(): string {
  return randomBytes(32).toString('hex');
}

@Injectable()
export class OpsAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ops_session_service: OpsSessionService,
    private readonly crypto_service: CryptoService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  // ── Step 1: email + password ──────────────────────────────────────────────
  //
  // On success, returns a transient challenge_id (or enrolment_token for
  // first-ever login) wrapped in a typed exception. The controller maps the
  // exception's HTTP status + body. Doing this via exception keeps the
  // success path of `login()` reserved for the literal "credentials valid AND
  // 2FA already cleared" case — which never happens in ops, since 2FA is
  // mandatory. So login() always throws on the happy path.
  async login(params: {
    email: string;
    password: string;
  }): Promise<never> {
    const email = params.email.toLowerCase();
    const ops_user = await this.prisma.opsUser.findUnique({ where: { email } });

    // Deliberately ambiguous: never differentiate "no such email" from
    // "wrong password" — same message keeps user-enumeration tight.
    if (!ops_user) throw new OpsInvalidCredentialsException();

    const password_ok = await argon2.verify(ops_user.password_hash, params.password);
    if (!password_ok) throw new OpsInvalidCredentialsException();

    if (!ops_user.is_active) throw new OpsUserDisabledException();

    if (!ops_user.totp_enabled) {
      const enrolment_token = newOpaqueToken();
      await this.redis.set(
        REDIS_KEYS.OPS_ENROLMENT(enrolment_token),
        ops_user.id,
        'EX',
        OPS_ENROLMENT_TTL_SEC,
      );
      throw new OpsTwoFactorEnrolmentRequiredException({ enrolment_token });
    }

    const challenge_id = newOpaqueToken();
    await this.redis.set(
      REDIS_KEYS.OPS_CHALLENGE(challenge_id),
      ops_user.id,
      'EX',
      OPS_CHALLENGE_TTL_SEC,
    );
    throw new OpsTwoFactorRequiredException({ challenge_id });
  }

  // ── Step 2: challenge_id + TOTP → session ─────────────────────────────────
  async verifyTwoFactor(params: {
    challenge_id: string;
    totp_code:    string;
    ip_address?:  string;
    user_agent?:  string;
  }): Promise<{ token: string }> {
    const challenge_key = REDIS_KEYS.OPS_CHALLENGE(params.challenge_id);
    const ops_user_id = await this.redis.get(challenge_key);
    if (!ops_user_id) throw new OpsTwoFactorInvalidException();

    const ops_user = await this.prisma.opsUser.findUnique({ where: { id: ops_user_id } });
    if (!ops_user || !ops_user.totp_enabled || !ops_user.totp_secret) {
      throw new OpsTwoFactorInvalidException();
    }
    if (!ops_user.is_active) throw new OpsUserDisabledException();

    const secret = this.crypto_service.decrypt(ops_user.totp_secret);
    const result = await totpVerify({ secret, token: params.totp_code });
    if (!result.valid) throw new OpsTwoFactorInvalidException();

    // Single-use: burn the challenge as soon as it succeeds. A leaked
    // challenge_id is worthless once redeemed.
    await this.redis.del(challenge_key);

    const token = await this.ops_session_service.create({
      ops_user_id: ops_user.id,
      ip_address: params.ip_address,
      user_agent: params.user_agent,
    });

    await this.prisma.opsUser.update({
      where: { id: ops_user.id },
      data: { last_login_at: new Date() },
    });

    return { token };
  }

  // ── Enrolment step 1: enrolment_token → secret + QR ───────────────────────
  //
  // Generates a fresh TOTP secret server-side (the secret never leaves the
  // server pre-encryption), persists the encrypted form on the OpsUser, and
  // returns the plaintext exactly once for the client to scan. Idempotent:
  // calling again with a still-valid enrolment_token re-issues a NEW secret
  // (and overwrites the old one) — defends the "QR didn't render, retry"
  // case without leaking the original secret across attempts.
  async startEnrolment(params: {
    enrolment_token: string;
  }): Promise<{ secret: string; qr_code_uri: string; otpauth_url: string }> {
    const ops_user = await this._resolveEnrolment(params.enrolment_token);

    const secret = generateSecret();
    const encrypted_secret = this.crypto_service.encrypt(secret);
    const otpauth_url = generateURI({ issuer: APP_NAME, label: ops_user.email, secret });
    const qr_code_uri = await QRCode.toDataURL(otpauth_url);

    await this.prisma.opsUser.update({
      where: { id: ops_user.id },
      data: { totp_secret: encrypted_secret, totp_enabled: false },
    });

    return { secret, qr_code_uri, otpauth_url };
  }

  // ── Enrolment step 2: enrolment_token + TOTP → session ────────────────────
  //
  // Verifies the TOTP code against the secret stored by startEnrolment, flips
  // totp_enabled=true, burns the enrolment_token, and issues a session in
  // one shot — saves the operator a redundant verify-2fa round-trip on the
  // very first login.
  async confirmEnrolment(params: {
    enrolment_token: string;
    totp_code:       string;
    ip_address?:     string;
    user_agent?:     string;
  }): Promise<{ token: string }> {
    const ops_user = await this._resolveEnrolment(params.enrolment_token);

    if (!ops_user.totp_secret) throw new OpsTwoFactorInvalidException();

    const secret = this.crypto_service.decrypt(ops_user.totp_secret);
    const result = await totpVerify({ secret, token: params.totp_code });
    if (!result.valid) throw new OpsTwoFactorInvalidException();

    await this.redis.del(REDIS_KEYS.OPS_ENROLMENT(params.enrolment_token));

    await this.prisma.opsUser.update({
      where: { id: ops_user.id },
      data: { totp_enabled: true, last_login_at: new Date() },
    });

    const token = await this.ops_session_service.create({
      ops_user_id: ops_user.id,
      ip_address: params.ip_address,
      user_agent: params.user_agent,
    });

    return { token };
  }

  async logout(token: string): Promise<void> {
    const token_hash = createHash('sha256').update(token).digest('hex');
    await this.ops_session_service.destroy(token_hash);
  }

  private async _resolveEnrolment(enrolment_token: string): Promise<OpsUser> {
    const ops_user_id = await this.redis.get(REDIS_KEYS.OPS_ENROLMENT(enrolment_token));
    if (!ops_user_id) throw new OpsTwoFactorInvalidException();

    const ops_user = await this.prisma.opsUser.findUnique({ where: { id: ops_user_id } });
    if (!ops_user) throw new OpsTwoFactorInvalidException();
    if (!ops_user.is_active) throw new OpsUserDisabledException();
    return ops_user;
  }
}
