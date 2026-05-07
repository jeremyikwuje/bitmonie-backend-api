jest.mock('argon2', () => ({
  hash: jest.fn().mockResolvedValue('$argon2id$mock'),
  verify: jest.fn().mockResolvedValue(false),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { mock, MockProxy } from 'jest-mock-extended';
import { TransactionPinService } from '@/modules/auth/transaction-pin.service';
import { AuthService } from '@/modules/auth/auth.service';
import { PrismaService } from '@/database/prisma.service';
import {
  TRANSACTION_PIN_MAX_ATTEMPTS,
  TRANSACTION_PIN_LOCKOUT_SEC,
} from '@/common/constants';

const USER_ID = 'user-uuid-001';

function make_user_pin_state(overrides: Record<string, unknown> = {}) {
  return {
    transaction_pin_hash:            '$argon2id$existing-hash',
    transaction_pin_set_at:          new Date('2026-01-01T00:00:00Z'),
    transaction_pin_failed_attempts: 0,
    transaction_pin_locked_until:    null as Date | null,
    ...overrides,
  };
}

function make_prisma() {
  return {
    user: {
      findUniqueOrThrow: jest.fn(),
      update:            jest.fn().mockResolvedValue({}),
    },
  };
}

describe('TransactionPinService', () => {
  let service: TransactionPinService;
  let prisma: ReturnType<typeof make_prisma>;
  let auth_service: MockProxy<AuthService>;

  beforeEach(async () => {
    prisma = make_prisma();
    auth_service = mock<AuthService>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionPinService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuthService,   useValue: auth_service },
      ],
    }).compile();

    service = module.get(TransactionPinService);
  });

  describe('requestSetOtp', () => {
    it('throws TRANSACTION_PIN_ALREADY_SET when a PIN already exists', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(make_user_pin_state());

      await expect(service.requestSetOtp(USER_ID))
        .rejects.toMatchObject({ code: 'TRANSACTION_PIN_ALREADY_SET' });

      expect(auth_service.sendTransactionPinOtp).not.toHaveBeenCalled();
    });

    it('delegates to AuthService.sendTransactionPinOtp when no PIN is set', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(
        make_user_pin_state({ transaction_pin_hash: null }),
      );

      await service.requestSetOtp(USER_ID);

      expect(auth_service.sendTransactionPinOtp)
        .toHaveBeenCalledWith(USER_ID, 'transaction_pin_set');
    });
  });

  describe('requestChangeOtp / requestDisableOtp', () => {
    it('requestChangeOtp throws TRANSACTION_PIN_NOT_SET when no PIN exists', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(
        make_user_pin_state({ transaction_pin_hash: null }),
      );

      await expect(service.requestChangeOtp(USER_ID))
        .rejects.toMatchObject({ code: 'TRANSACTION_PIN_NOT_SET' });
    });

    it('requestDisableOtp throws TRANSACTION_PIN_NOT_SET when no PIN exists', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(
        make_user_pin_state({ transaction_pin_hash: null }),
      );

      await expect(service.requestDisableOtp(USER_ID))
        .rejects.toMatchObject({ code: 'TRANSACTION_PIN_NOT_SET' });
    });
  });

  describe('setPin', () => {
    it('refuses if a PIN is already set', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(make_user_pin_state());

      await expect(
        service.setPin(USER_ID, { email_otp: '123456', transaction_pin: '142857' }),
      ).rejects.toMatchObject({ code: 'TRANSACTION_PIN_ALREADY_SET' });
    });

    it('hashes + writes the new PIN, resets attempts counters', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(
        make_user_pin_state({ transaction_pin_hash: null }),
      );

      await service.setPin(USER_ID, { email_otp: '123456', transaction_pin: '142857' });

      expect(auth_service.consumeTransactionPinOtp)
        .toHaveBeenCalledWith(USER_ID, 'transaction_pin_set', '123456');
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data:  expect.objectContaining({
          transaction_pin_hash:            expect.any(String),
          transaction_pin_failed_attempts: 0,
          transaction_pin_locked_until:    null,
        }),
      });
    });
  });

  describe('changePin', () => {
    it('verifies current PIN BEFORE consuming the email OTP (so a typo does not waste the OTP)', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValueOnce(make_user_pin_state());
      const argon2 = await import('argon2');
      (argon2.verify as jest.Mock).mockResolvedValueOnce(false);

      await expect(
        service.changePin(USER_ID, {
          current_transaction_pin: '000000',
          email_otp:               '123456',
          new_transaction_pin:     '142857',
        }),
      ).rejects.toMatchObject({ code: 'TRANSACTION_PIN_INVALID' });

      // The OTP must NOT have been consumed because the PIN check failed first.
      expect(auth_service.consumeTransactionPinOtp).not.toHaveBeenCalled();
    });

    it('rotates the PIN on the happy path', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(make_user_pin_state());
      const argon2 = await import('argon2');
      (argon2.verify as jest.Mock).mockResolvedValueOnce(true);

      await service.changePin(USER_ID, {
        current_transaction_pin: '000000',
        email_otp:               '123456',
        new_transaction_pin:     '142857',
      });

      expect(auth_service.consumeTransactionPinOtp)
        .toHaveBeenCalledWith(USER_ID, 'transaction_pin_change', '123456');
      // Counters were already at zero with no lockout — verifyCurrentPinOrThrow
      // skips the counter-clear write, so only the rotate update fires.
      expect(prisma.user.update).toHaveBeenCalledTimes(1);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data:  expect.objectContaining({
          transaction_pin_hash:            expect.any(String),
          transaction_pin_failed_attempts: 0,
          transaction_pin_locked_until:    null,
        }),
      });
    });
  });

  describe('disablePin', () => {
    it('rejects when neither current_transaction_pin nor totp_code is provided', async () => {
      await expect(
        service.disablePin(USER_ID, { email_otp: '123456' }),
      ).rejects.toMatchObject({ code: 'TRANSACTION_PIN_INVALID' });

      // No DB lookup needed — short-circuit before that.
      expect(prisma.user.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it('PIN path — verifies current PIN then consumes OTP and clears all PIN columns', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(make_user_pin_state());
      const argon2 = await import('argon2');
      (argon2.verify as jest.Mock).mockResolvedValueOnce(true);

      await service.disablePin(USER_ID, {
        current_transaction_pin: '000000',
        email_otp:               '123456',
      });

      expect(auth_service.consumeTransactionPinOtp)
        .toHaveBeenCalledWith(USER_ID, 'transaction_pin_disable', '123456');
      // Two updates: counter-clear after verify, then the disable write.
      expect(prisma.user.update).toHaveBeenLastCalledWith({
        where: { id: USER_ID },
        data:  expect.objectContaining({ transaction_pin_hash: null }),
      });
    });

    it('TOTP path — delegates to AuthService.verifyTotpForUser when no PIN provided', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(make_user_pin_state());

      await service.disablePin(USER_ID, {
        email_otp: '123456',
        totp_code: '999999',
      });

      expect(auth_service.verifyTotpForUser).toHaveBeenCalledWith(USER_ID, '999999');
      expect(auth_service.consumeTransactionPinOtp)
        .toHaveBeenCalledWith(USER_ID, 'transaction_pin_disable', '123456');
    });
  });

  describe('verifyPinOrThrow lockout', () => {
    it('on Nth wrong attempt locks the PIN for the configured cool-down window', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(make_user_pin_state({
        transaction_pin_failed_attempts: TRANSACTION_PIN_MAX_ATTEMPTS - 1,
      }));
      const argon2 = await import('argon2');
      (argon2.verify as jest.Mock).mockResolvedValueOnce(false);

      const before = Date.now();
      await expect(service.verifyPinOrThrow(USER_ID, '000000'))
        .rejects.toMatchObject({ code: 'TRANSACTION_PIN_LOCKED' });

      const update_call = prisma.user.update.mock.calls.find(
        (c) => c[0]?.data?.transaction_pin_locked_until !== null,
      );
      expect(update_call).toBeTruthy();
      const lock_until = update_call![0].data.transaction_pin_locked_until as Date;
      const skew_ms    = lock_until.getTime() - before;
      // 15 min ± a few seconds for jitter on slow CI
      expect(skew_ms).toBeGreaterThan(TRANSACTION_PIN_LOCKOUT_SEC * 1_000 - 5_000);
      expect(skew_ms).toBeLessThan(TRANSACTION_PIN_LOCKOUT_SEC * 1_000 + 5_000);
    });

    it('refuses immediately when transaction_pin_locked_until is in the future', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(make_user_pin_state({
        transaction_pin_locked_until: new Date(Date.now() + 60_000),
      }));

      await expect(service.verifyPinOrThrow(USER_ID, '000000'))
        .rejects.toMatchObject({ code: 'TRANSACTION_PIN_LOCKED' });

      // No argon2 verify, no counter update — short-circuited by lockout.
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('clears counters on successful verify when they were non-zero', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(make_user_pin_state({
        transaction_pin_failed_attempts: 2,
      }));
      const argon2 = await import('argon2');
      (argon2.verify as jest.Mock).mockResolvedValueOnce(true);

      await service.verifyPinOrThrow(USER_ID, '142857');

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data:  { transaction_pin_failed_attempts: 0, transaction_pin_locked_until: null },
      });
    });
  });
});
