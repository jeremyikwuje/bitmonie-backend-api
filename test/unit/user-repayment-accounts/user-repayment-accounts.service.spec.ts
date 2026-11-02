import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { mock, MockProxy } from 'jest-mock-extended';
import { KycIdType } from '@prisma/client';
import { UserRepaymentAccountsService } from '@/modules/user-repayment-accounts/user-repayment-accounts.service';
import type { CollectionProvider } from '@/modules/loans/collection.provider.interface';
import { CryptoService } from '@/common/crypto/crypto.service';
import { PrismaService } from '@/database/prisma.service';

const USER_ID = 'user-uuid-001';

const BLOOM_VA = {
  id:                   'va-bloom',
  user_id:              USER_ID,
  virtual_account_no:   '9931107760',
  virtual_account_name: 'Ada Obi',
  bank_name:            'Bloom Microfinance Bank',
  provider:             'palmpay',
  is_active:            true,
};

const BOOST_VA = {
  virtual_account_no:   '0100123456',
  virtual_account_name: 'Ada Obi',
  bank_name:            'Boost Microfinance Bank',
};

const TIER_1 = {
  encrypted_id_number: 'enc-bvn',
  legal_name:          'OBI ADA',
  id_type:             KycIdType.BVN,
  user:                { first_name: 'Ada', last_name: 'Obi' },
};

type FakeTx = {
  userRepaymentAccount: { create: jest.Mock; updateMany: jest.Mock };
};

function make_prisma() {
  const tx: FakeTx = {
    userRepaymentAccount: {
      create:     jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'va-new', ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  return {
    userRepaymentAccount: { findFirst: jest.fn().mockResolvedValue(null) },
    kycVerification:      { findUnique: jest.fn().mockResolvedValue(TIER_1) },
    $transaction:         jest.fn().mockImplementation((fn: (tx: FakeTx) => Promise<unknown>) => fn(tx)),
    _tx:                  tx,
  };
}

describe('UserRepaymentAccountsService', () => {
  let service:    UserRepaymentAccountsService;
  let prisma:     ReturnType<typeof make_prisma>;
  let collection: MockProxy<CollectionProvider>;

  beforeEach(async () => {
    prisma     = make_prisma();
    collection = mock<CollectionProvider>();
    collection.createVirtualAccount.mockResolvedValue(BOOST_VA);
    const crypto_service = mock<CryptoService>();
    crypto_service.decrypt.mockReturnValue('12345678901');
    const config = mock<ConfigService>();
    config.get.mockReturnValue({ active: { collection: 'palmpay' } });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserRepaymentAccountsService,
        { provide: PrismaService,         useValue: prisma },
        { provide: CryptoService,         useValue: crypto_service },
        { provide: ConfigService,         useValue: config },
        { provide: 'COLLECTION_PROVIDER', useValue: collection },
      ],
    }).compile();

    service = module.get(UserRepaymentAccountsService);
  });

  describe('ensureForUser', () => {
    it('returns the active VA without calling the provider', async () => {
      prisma.userRepaymentAccount.findFirst.mockResolvedValue(BLOOM_VA);

      const result = await service.ensureForUser(USER_ID);

      expect(prisma.userRepaymentAccount.findFirst).toHaveBeenCalledWith({
        where: { user_id: USER_ID, is_active: true },
      });
      expect(result).toEqual({
        summary: expect.objectContaining({ virtual_account_no: '9931107760' }),
        created: false,
      });
      expect(collection.createVirtualAccount).not.toHaveBeenCalled();
    });

    it('provisions a VA referenced by the user id when the user has no active one', async () => {
      const result = await service.ensureForUser(USER_ID);

      expect(collection.createVirtualAccount).toHaveBeenCalledWith(
        expect.objectContaining({ account_reference: USER_ID, identity_type: 'BVN' }),
      );
      expect(prisma._tx.userRepaymentAccount.updateMany).not.toHaveBeenCalled();
      expect(result).toEqual({
        summary: expect.objectContaining({ virtual_account_no: '0100123456' }),
        created: true,
      });
    });
  });

  describe('replaceForUser', () => {
    it('issues the new VA, then retires the active one and records the new one', async () => {
      prisma.userRepaymentAccount.findFirst.mockResolvedValue(BLOOM_VA);

      const result = await service.replaceForUser(USER_ID);

      expect(collection.createVirtualAccount).toHaveBeenCalledWith(
        expect.objectContaining({ account_reference: expect.stringMatching(new RegExp(`^${USER_ID}-\\d+$`)) }),
      );
      const create_order = collection.createVirtualAccount.mock.invocationCallOrder[0]!;
      const retire_order = prisma._tx.userRepaymentAccount.updateMany.mock.invocationCallOrder[0]!;
      expect(create_order).toBeLessThan(retire_order);

      expect(prisma._tx.userRepaymentAccount.updateMany).toHaveBeenCalledWith({
        where: { user_id: USER_ID, is_active: true },
        data:  { is_active: false, deactivated_at: expect.any(Date) },
      });
      expect(prisma._tx.userRepaymentAccount.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          user_id:            USER_ID,
          virtual_account_no: '0100123456',
          bank_name:          'Boost Microfinance Bank',
          provider:           'palmpay',
        }),
      });
      expect(result).toEqual({
        summary: expect.objectContaining({ virtual_account_no: '0100123456' }),
        retired: expect.objectContaining({ virtual_account_no: '9931107760', bank_name: 'Bloom Microfinance Bank' }),
      });
    });

    it('leaves the old VA active when the provider refuses the new one', async () => {
      prisma.userRepaymentAccount.findFirst.mockResolvedValue(BLOOM_VA);
      collection.createVirtualAccount.mockRejectedValue(new Error('PalmPay createVirtualAccount failed: 00000008'));

      await expect(service.replaceForUser(USER_ID)).rejects.toThrow('00000008');
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma._tx.userRepaymentAccount.updateMany).not.toHaveBeenCalled();
    });

    it('returns null and leaves the old VA active when tier-1 KYC cannot back a new one', async () => {
      prisma.userRepaymentAccount.findFirst.mockResolvedValue(BLOOM_VA);
      prisma.kycVerification.findUnique.mockResolvedValue(null);

      expect(await service.replaceForUser(USER_ID)).toBeNull();
      expect(collection.createVirtualAccount).not.toHaveBeenCalled();
      expect(prisma._tx.userRepaymentAccount.updateMany).not.toHaveBeenCalled();
    });
  });
});
