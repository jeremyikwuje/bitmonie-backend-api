import { Test, TestingModule } from '@nestjs/testing';
import { mock, MockProxy } from 'jest-mock-extended';
import { StepUpService } from '@/modules/auth/step-up.service';
import { AuthService } from '@/modules/auth/auth.service';
import { TransactionPinService } from '@/modules/auth/transaction-pin.service';
import { PrismaService } from '@/database/prisma.service';

const USER_ID = 'user-uuid-001';

function make_prisma() {
  return {
    user: { findUniqueOrThrow: jest.fn() },
  };
}

describe('StepUpService', () => {
  let service: StepUpService;
  let prisma: ReturnType<typeof make_prisma>;
  let auth_service: MockProxy<AuthService>;
  let transaction_pin_service: MockProxy<TransactionPinService>;

  beforeEach(async () => {
    prisma = make_prisma();
    auth_service = mock<AuthService>();
    transaction_pin_service = mock<TransactionPinService>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StepUpService,
        { provide: PrismaService,          useValue: prisma },
        { provide: AuthService,            useValue: auth_service },
        { provide: TransactionPinService,  useValue: transaction_pin_service },
      ],
    }).compile();

    service = module.get(StepUpService);
  });

  describe('assertHasAnyFactorConfigured', () => {
    it('throws TRANSACTION_FACTOR_NOT_SET when neither PIN nor TOTP is configured', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        totp_enabled: false,
        transaction_pin_hash: null,
      });
      await expect(service.assertHasAnyFactorConfigured(USER_ID))
        .rejects.toMatchObject({ code: 'TRANSACTION_FACTOR_NOT_SET' });
    });

    it('passes when only PIN is configured', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        totp_enabled: false,
        transaction_pin_hash: '$argon2id$x',
      });
      await expect(service.assertHasAnyFactorConfigured(USER_ID)).resolves.toBeUndefined();
    });

    it('passes when only TOTP is configured', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        totp_enabled: true,
        transaction_pin_hash: null,
      });
      await expect(service.assertHasAnyFactorConfigured(USER_ID)).resolves.toBeUndefined();
    });
  });

  describe('verifyTransactionFactor', () => {
    it('throws TRANSACTION_FACTOR_REQUIRED when neither factor is provided', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        totp_enabled: true,
        transaction_pin_hash: '$argon2id$x',
      });
      await expect(service.verifyTransactionFactor(USER_ID, {}))
        .rejects.toMatchObject({ code: 'TRANSACTION_FACTOR_REQUIRED' });
    });

    it('routes to TransactionPinService when transaction_pin is provided (preferred over totp)', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        totp_enabled: true,
        transaction_pin_hash: '$argon2id$x',
      });

      await service.verifyTransactionFactor(USER_ID, {
        transaction_pin: '142857',
        totp_code:       '999999',
      });

      expect(transaction_pin_service.verifyPinOrThrow).toHaveBeenCalledWith(USER_ID, '142857');
      expect(auth_service.verifyTotpForUser).not.toHaveBeenCalled();
    });

    it('routes to AuthService.verifyTotpForUser when only totp_code is provided', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        totp_enabled: true,
        transaction_pin_hash: null,
      });

      await service.verifyTransactionFactor(USER_ID, { totp_code: '999999' });

      expect(auth_service.verifyTotpForUser).toHaveBeenCalledWith(USER_ID, '999999');
      expect(transaction_pin_service.verifyPinOrThrow).not.toHaveBeenCalled();
    });

    it('refuses outright if no factor is configured (regardless of what was submitted)', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        totp_enabled: false,
        transaction_pin_hash: null,
      });

      await expect(
        service.verifyTransactionFactor(USER_ID, { transaction_pin: '142857' }),
      ).rejects.toMatchObject({ code: 'TRANSACTION_FACTOR_NOT_SET' });

      expect(transaction_pin_service.verifyPinOrThrow).not.toHaveBeenCalled();
    });
  });
});
