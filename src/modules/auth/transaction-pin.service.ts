import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '@/database/prisma.service';
import { AuthService } from './auth.service';
import {
  TRANSACTION_PIN_MAX_ATTEMPTS,
  TRANSACTION_PIN_LOCKOUT_SEC,
} from '@/common/constants';
import {
  TransactionPinNotSetException,
  TransactionPinAlreadySetException,
  TransactionPinInvalidException,
  TransactionPinLockedException,
  Auth2faRequiredException,
} from '@/common/errors/bitmonie.errors';
import type {
  SetTransactionPinDto,
  ChangeTransactionPinDto,
  DisableTransactionPinDto,
} from './dto/set-transaction-pin.dto';

// Customer-facing transaction PIN.
//
// PIN is an OPT-IN second factor for sensitive transactional ops (e.g.
// changing the collateral release address). It is NEVER asked at login —
// login is single-factor email-OTP. Either a PIN OR TOTP must be set for
// the user to perform a sensitive op (StepUpService enforces this). When
// both are set, the user picks which to submit per request.
//
// Mutations (set / change / disable) all require an email OTP first
// (proves possession of the inbox), exactly the same discipline as the
// release-address change flow.
@Injectable()
export class TransactionPinService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth_service: AuthService,
  ) {}

  // ── OTP requests ───────────────────────────────────────────────────────────

  // Refuses if a PIN is already set; the customer should call request-change
  // -otp instead. The error message points the caller to the right endpoint
  // so the web client can map exception code → next step without parsing
  // human strings.
  async requestSetOtp(user_id: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where:  { id: user_id },
      select: { transaction_pin_hash: true },
    });
    if (user.transaction_pin_hash) throw new TransactionPinAlreadySetException();
    await this.auth_service.sendTransactionPinOtp(user_id, 'transaction_pin_set');
  }

  async requestChangeOtp(user_id: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where:  { id: user_id },
      select: { transaction_pin_hash: true },
    });
    if (!user.transaction_pin_hash) throw new TransactionPinNotSetException();
    await this.auth_service.sendTransactionPinOtp(user_id, 'transaction_pin_change');
  }

  async requestDisableOtp(user_id: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where:  { id: user_id },
      select: { transaction_pin_hash: true },
    });
    if (!user.transaction_pin_hash) throw new TransactionPinNotSetException();
    await this.auth_service.sendTransactionPinOtp(user_id, 'transaction_pin_disable');
  }

  // ── Mutations ──────────────────────────────────────────────────────────────

  async setPin(user_id: string, dto: SetTransactionPinDto): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where:  { id: user_id },
      select: { transaction_pin_hash: true },
    });
    if (user.transaction_pin_hash) throw new TransactionPinAlreadySetException();

    await this.auth_service.consumeTransactionPinOtp(user_id, 'transaction_pin_set', dto.email_otp);

    const hash = await argon2.hash(dto.transaction_pin);
    await this.prisma.user.update({
      where: { id: user_id },
      data:  {
        transaction_pin_hash:            hash,
        transaction_pin_set_at:          new Date(),
        transaction_pin_failed_attempts: 0,
        transaction_pin_locked_until:    null,
      },
    });
  }

  async changePin(user_id: string, dto: ChangeTransactionPinDto): Promise<void> {
    // Order matters here.
    //
    // 1. Verify the current PIN first. This is the gate that proves the
    //    requester knows the existing secret — without it, an attacker who
    //    only stole the email inbox could rotate the PIN at will.
    // 2. Email OTP next, after the PIN check passed. Both are required, but
    //    we want a wrong-PIN attempt to count against the PIN lockout
    //    (deterring online brute force) WITHOUT consuming the OTP — so the
    //    legitimate user doesn't have to request a fresh OTP after a typo.
    await this.verifyCurrentPinOrThrow(user_id, dto.current_transaction_pin);
    await this.auth_service.consumeTransactionPinOtp(user_id, 'transaction_pin_change', dto.email_otp);

    const hash = await argon2.hash(dto.new_transaction_pin);
    await this.prisma.user.update({
      where: { id: user_id },
      data:  {
        transaction_pin_hash:            hash,
        transaction_pin_set_at:          new Date(),
        transaction_pin_failed_attempts: 0,
        transaction_pin_locked_until:    null,
      },
    });
  }

  async disablePin(user_id: string, dto: DisableTransactionPinDto): Promise<void> {
    // Disable accepts EITHER the current PIN OR a TOTP code (when 2FA is
    // enabled). This handles the "I forgot my PIN but I have my authenticator"
    // recovery path without falling back to support intervention. Email OTP
    // is still required as a second factor on top of whichever is chosen.
    if (!dto.current_transaction_pin && !dto.totp_code) {
      throw new TransactionPinInvalidException();
    }

    if (dto.current_transaction_pin) {
      await this.verifyCurrentPinOrThrow(user_id, dto.current_transaction_pin);
    } else {
      // No PIN provided → must verify TOTP. If user is not 2FA-enabled this
      // throws Auth2faRequiredException — they need to come back with the PIN.
      if (!dto.totp_code) throw new Auth2faRequiredException();
      await this.auth_service.verifyTotpForUser(user_id, dto.totp_code);
    }

    await this.auth_service.consumeTransactionPinOtp(user_id, 'transaction_pin_disable', dto.email_otp);

    await this.prisma.user.update({
      where: { id: user_id },
      data:  {
        transaction_pin_hash:            null,
        transaction_pin_set_at:          null,
        transaction_pin_failed_attempts: 0,
        transaction_pin_locked_until:    null,
      },
    });
  }

  // ── Verification (used by StepUpService for sensitive ops) ────────────────
  //
  // Public so StepUpService can verify a submitted PIN without going through
  // the full set/change/disable flow. Lockout state lives on the User row
  // and is cleared on successful verify. Wrong PIN increments attempts and,
  // on hitting MAX, sets `transaction_pin_locked_until`.

  async verifyPinOrThrow(user_id: string, transaction_pin: string): Promise<void> {
    return this.verifyCurrentPinOrThrow(user_id, transaction_pin);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async verifyCurrentPinOrThrow(user_id: string, pin: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where:  { id: user_id },
      select: {
        transaction_pin_hash:            true,
        transaction_pin_failed_attempts: true,
        transaction_pin_locked_until:    true,
      },
    });

    if (!user.transaction_pin_hash) throw new TransactionPinNotSetException();

    if (user.transaction_pin_locked_until && user.transaction_pin_locked_until > new Date()) {
      throw new TransactionPinLockedException({
        unlocks_at: user.transaction_pin_locked_until.toISOString(),
      });
    }

    const ok = await argon2.verify(user.transaction_pin_hash, pin);
    if (ok) {
      // Reset counters on successful verify. Skip the write if already zero
      // to avoid a hot-path UPDATE on every successful PIN check.
      if (user.transaction_pin_failed_attempts > 0 || user.transaction_pin_locked_until !== null) {
        await this.prisma.user.update({
          where: { id: user_id },
          data:  { transaction_pin_failed_attempts: 0, transaction_pin_locked_until: null },
        });
      }
      return;
    }

    const next_attempts = user.transaction_pin_failed_attempts + 1;
    const should_lock = next_attempts >= TRANSACTION_PIN_MAX_ATTEMPTS;
    const lock_until = should_lock
      ? new Date(Date.now() + TRANSACTION_PIN_LOCKOUT_SEC * 1_000)
      : null;

    await this.prisma.user.update({
      where: { id: user_id },
      data:  {
        // Reset to 0 once we lock — when the lockout expires, the user gets
        // a fresh window of attempts. Otherwise this would force a manual
        // counter reset somewhere we don't have a hook for.
        transaction_pin_failed_attempts: should_lock ? 0 : next_attempts,
        transaction_pin_locked_until:    lock_until,
      },
    });

    if (should_lock) {
      throw new TransactionPinLockedException({
        unlocks_at: lock_until!.toISOString(),
      });
    }
    throw new TransactionPinInvalidException();
  }
}
