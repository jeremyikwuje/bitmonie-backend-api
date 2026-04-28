import { Test, TestingModule } from '@nestjs/testing';
import { mock, MockProxy } from 'jest-mock-extended';
import { DisbursementAccountKind, DisbursementAccountStatus } from '@prisma/client';
import { DisbursementAccountsService } from '@/modules/disbursement-accounts/disbursement-accounts.service';
import { DisbursementRouter } from '@/modules/disbursements/disbursement-router.service';
import type { DisbursementProvider } from '@/modules/disbursements/disbursement.provider.interface';
import { NameMatchService } from '@/common/name-match/name-match.service';
import { PrismaService } from '@/database/prisma.service';

const KYC_USER = {
  id: 'user-uuid',
  kyc_tier: 1,
  first_name: 'Ada',
  middle_name: null,
  last_name: 'Obi',
};

const UNVERIFIED_USER = { ...KYC_USER, kyc_tier: 0 };

const BANK_DTO = {
  kind: DisbursementAccountKind.BANK,
  provider_name: 'GTBank',
  provider_code: '058',
  account_unique: '0123456789',
};

const CRYPTO_DTO = {
  kind: DisbursementAccountKind.CRYPTO_ADDRESS,
  provider_name: 'BTC',
  provider_code: 'BTC',
  account_unique: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
};

function make_prisma() {
  return {
    user: { findUniqueOrThrow: jest.fn() },
    kycVerification: {
      findUnique: jest.fn().mockResolvedValue({ legal_name: 'Ada Obi' }),
    },
    disbursementAccount: {
      count: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
    },
    $transaction: jest.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        disbursementAccount: {
          updateMany: jest.fn().mockResolvedValue({}),
          update: jest.fn().mockResolvedValue({}),
        },
      }),
    ),
  };
}

describe('DisbursementAccountsService', () => {
  let service: DisbursementAccountsService;
  let prisma: ReturnType<typeof make_prisma>;
  let disbursement_provider: MockProxy<DisbursementProvider>;
  let router: MockProxy<DisbursementRouter>;

  beforeEach(async () => {
    prisma = make_prisma();
    disbursement_provider = mock<DisbursementProvider>();
    router = mock<DisbursementRouter>();
    router.forRoute.mockReturnValue(disbursement_provider);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DisbursementAccountsService,
        NameMatchService,
        { provide: PrismaService, useValue: prisma },
        { provide: DisbursementRouter, useValue: router },
      ],
    }).compile();

    service = module.get(DisbursementAccountsService);
  });

  // ── addAccount ──────────────────────────────────────────────────────────────

  describe('addAccount', () => {
    it('adds a BANK account when name matches', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(KYC_USER);
      prisma.disbursementAccount.count.mockResolvedValue(0);
      disbursement_provider.lookupAccountName.mockResolvedValue('Ada Obi');
      prisma.disbursementAccount.create.mockResolvedValue({ id: 'acct-uuid' });

      const result = await service.addAccount('user-uuid', BANK_DTO);

      expect(result.id).toBe('acct-uuid');
      expect(result.message).toContain('added');
      expect(disbursement_provider.lookupAccountName).toHaveBeenCalledWith({
        bank_code: '058',
        account_number: '0123456789',
      });
    });

    it('sets is_default=true for first account of its kind', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(KYC_USER);
      prisma.disbursementAccount.count.mockResolvedValue(0);
      disbursement_provider.lookupAccountName.mockResolvedValue('Ada Obi');
      prisma.disbursementAccount.create.mockResolvedValue({ id: 'acct-uuid' });

      await service.addAccount('user-uuid', BANK_DTO);

      expect(prisma.disbursementAccount.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ is_default: true }) }),
      );
    });

    it('sets is_default=false for subsequent accounts', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(KYC_USER);
      prisma.disbursementAccount.count.mockResolvedValue(2);
      disbursement_provider.lookupAccountName.mockResolvedValue('Ada Obi');
      prisma.disbursementAccount.create.mockResolvedValue({ id: 'acct-uuid' });

      await service.addAccount('user-uuid', BANK_DTO);

      expect(prisma.disbursementAccount.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ is_default: false }) }),
      );
    });

    it('throws DISBURSEMENT_ACCOUNT_NAME_MISMATCH when score is too low', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(KYC_USER);
      prisma.disbursementAccount.count.mockResolvedValue(0);
      disbursement_provider.lookupAccountName.mockResolvedValue('Chukwuemeka Nwosu');

      await expect(service.addAccount('user-uuid', BANK_DTO))
        .rejects.toMatchObject({ code: 'DISBURSEMENT_ACCOUNT_NAME_MISMATCH' });
    });

    it('throws DISBURSEMENT_ACCOUNT_MAX_PER_KIND when limit reached', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(KYC_USER);
      prisma.disbursementAccount.count.mockResolvedValue(5);

      await expect(service.addAccount('user-uuid', BANK_DTO))
        .rejects.toMatchObject({ code: 'DISBURSEMENT_ACCOUNT_MAX_PER_KIND' });
    });

    it('skips name lookup for CRYPTO_ADDRESS', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(UNVERIFIED_USER);
      prisma.disbursementAccount.count.mockResolvedValue(0);
      prisma.disbursementAccount.create.mockResolvedValue({ id: 'acct-uuid' });

      const result = await service.addAccount('user-uuid', CRYPTO_DTO);

      expect(result.id).toBe('acct-uuid');
      expect(disbursement_provider.lookupAccountName).not.toHaveBeenCalled();
    });

    it('throws DISBURSEMENT_ACCOUNT_LOOKUP_FAILED when provider returns no name', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(KYC_USER);
      prisma.disbursementAccount.count.mockResolvedValue(0);
      disbursement_provider.lookupAccountName.mockResolvedValue(null);

      await expect(service.addAccount('user-uuid', BANK_DTO))
        .rejects.toMatchObject({ code: 'DISBURSEMENT_ACCOUNT_LOOKUP_FAILED' });
      expect(prisma.disbursementAccount.create).not.toHaveBeenCalled();
    });
  });

  // ── listAccounts ────────────────────────────────────────────────────────────

  describe('listAccounts', () => {
    it('returns list with defaults first', async () => {
      const mock_accounts = [
        { id: 'a1', kind: DisbursementAccountKind.BANK, is_default: true, provider_name: 'GTBank', provider_code: '058', account_unique: '0123456789', account_unique_tag: null, label: null, account_holder_name: 'Ada Obi', status: DisbursementAccountStatus.VERIFIED, created_at: new Date() },
        { id: 'a2', kind: DisbursementAccountKind.BANK, is_default: false, provider_name: 'Zenith', provider_code: '057', account_unique: '9876543210', account_unique_tag: null, label: null, account_holder_name: 'Ada Obi', status: DisbursementAccountStatus.VERIFIED, created_at: new Date() },
      ];
      prisma.disbursementAccount.findMany.mockResolvedValue(mock_accounts);

      const result = await service.listAccounts('user-uuid');

      expect(result.accounts).toHaveLength(2);
    });
  });

  // ── setDefault ──────────────────────────────────────────────────────────────

  describe('setDefault', () => {
    it('sets the target account as default', async () => {
      prisma.disbursementAccount.findFirst.mockResolvedValue({
        id: 'acct-uuid',
        kind: DisbursementAccountKind.BANK,
      });

      const result = await service.setDefault('user-uuid', 'acct-uuid');

      expect(result.message).toContain('updated');
    });

    it('throws 404 when account not found', async () => {
      prisma.disbursementAccount.findFirst.mockResolvedValue(null);

      await expect(service.setDefault('user-uuid', 'acct-uuid'))
        .rejects.toMatchObject({ status: 404 });
    });
  });

  // ── deleteAccount ───────────────────────────────────────────────────────────

  describe('deleteAccount', () => {
    it('deletes non-default account', async () => {
      prisma.disbursementAccount.findFirst.mockResolvedValue({
        id: 'acct-uuid',
        kind: DisbursementAccountKind.BANK,
        is_default: false,
      });
      prisma.disbursementAccount.delete.mockResolvedValue({});

      const result = await service.deleteAccount('user-uuid', 'acct-uuid');

      expect(result.message).toContain('deleted');
    });

    it('throws DISBURSEMENT_ACCOUNT_DEFAULT_DELETE when deleting sole default', async () => {
      prisma.disbursementAccount.findFirst.mockResolvedValue({
        id: 'acct-uuid',
        kind: DisbursementAccountKind.BANK,
        is_default: true,
      });
      prisma.disbursementAccount.count.mockResolvedValue(1);

      await expect(service.deleteAccount('user-uuid', 'acct-uuid'))
        .rejects.toMatchObject({ code: 'DISBURSEMENT_ACCOUNT_DEFAULT_DELETE' });
    });

    it('allows deleting default when another account exists for same kind', async () => {
      prisma.disbursementAccount.findFirst.mockResolvedValue({
        id: 'acct-uuid',
        kind: DisbursementAccountKind.BANK,
        is_default: true,
      });
      prisma.disbursementAccount.count.mockResolvedValue(2);
      prisma.disbursementAccount.delete.mockResolvedValue({});

      const result = await service.deleteAccount('user-uuid', 'acct-uuid');

      expect(result.message).toContain('deleted');
    });

    it('throws 404 when account not found', async () => {
      prisma.disbursementAccount.findFirst.mockResolvedValue(null);

      await expect(service.deleteAccount('user-uuid', 'acct-uuid'))
        .rejects.toMatchObject({ status: 404 });
    });
  });
});
