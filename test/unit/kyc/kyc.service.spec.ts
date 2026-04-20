import { Test, TestingModule } from '@nestjs/testing';
import { mock, MockProxy } from 'jest-mock-extended';
import { KycStatus, KycIdType } from '@prisma/client';
import { KycService } from '@/modules/kyc/kyc.service';
import { KYC_PROVIDER_T1, KYC_PROVIDER_T2, KYC_PROVIDER_T3 } from '@/modules/kyc/kyc.provider.interface';
import type { KycProvider } from '@/modules/kyc/kyc.provider.interface';
import { CryptoService } from '@/common/crypto/crypto.service';
import { NameMatchService } from '@/common/name-match/name-match.service';
import { PrismaService } from '@/database/prisma.service';

type FakeTx = {
  kycVerification: { upsert: jest.Mock; deleteMany: jest.Mock };
  user: { update: jest.Mock };
};

function make_prisma() {
  const tx: FakeTx = {
    kycVerification: {
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    user: { update: jest.fn().mockResolvedValue({}) },
  };
  return {
    kycVerification: { findUnique: jest.fn(), findMany: jest.fn() },
    user: { findUniqueOrThrow: jest.fn() },
    $transaction: jest.fn().mockImplementation((fn: (tx: FakeTx) => Promise<unknown>) => fn(tx)),
  };
}

const VALID_DTO = {
  id_type: KycIdType.BVN,
  id_number: '12345678901',
  first_name: 'Ada',
  last_name: 'Obi',
  date_of_birth: '1990-05-15',
};

const MATCH_RESULT = {
  legal_name: 'Ada Obi',
  provider_reference: '12345678901',
  date_of_birth: '1990-05-15',
  raw_response: { source: 'test' },
};

describe('KycService', () => {
  let service: KycService;
  let prisma: ReturnType<typeof make_prisma>;
  let kyc_provider: MockProxy<KycProvider>;
  let crypto_service: MockProxy<CryptoService>;

  beforeEach(async () => {
    prisma = make_prisma();
    kyc_provider = mock<KycProvider>();
    crypto_service = mock<CryptoService>();
    crypto_service.encrypt.mockReturnValue('encrypted-id');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KycService,
        NameMatchService,
        { provide: PrismaService, useValue: prisma },
        { provide: CryptoService, useValue: crypto_service },
        { provide: KYC_PROVIDER_T1, useValue: kyc_provider },
        { provide: KYC_PROVIDER_T2, useValue: kyc_provider },
        { provide: KYC_PROVIDER_T3, useValue: kyc_provider },
      ],
    }).compile();

    service = module.get(KycService);
  });

  // ── submitTier1 ─────────────────────────────────────────────────────────────

  describe('submitTier1', () => {
    it('verifies BVN when name and DOB match', async () => {
      prisma.kycVerification.findUnique.mockResolvedValue(null);
      kyc_provider.verifyBvn.mockResolvedValue(MATCH_RESULT);

      const result = await service.submitTier1('user-uuid', VALID_DTO);

      expect(result.message).toContain('verified');
      expect(kyc_provider.verifyBvn).toHaveBeenCalledWith({
        id_number: '12345678901',
        first_name: 'Ada',
        last_name: 'Obi',
        middle_name: undefined,
        date_of_birth: '1990-05-15',
      });
    });

    it('verifies NIN successfully', async () => {
      prisma.kycVerification.findUnique.mockResolvedValue(null);
      kyc_provider.verifyNin.mockResolvedValue({ ...MATCH_RESULT, provider_reference: '98765432100' });

      const result = await service.submitTier1('user-uuid', {
        ...VALID_DTO, id_type: KycIdType.NIN, id_number: '98765432100',
      });

      expect(result.message).toContain('verified');
    });

    it('verifies Passport successfully', async () => {
      prisma.kycVerification.findUnique.mockResolvedValue(null);
      kyc_provider.verifyPassport.mockResolvedValue({ ...MATCH_RESULT, provider_reference: 'A12345678' });

      const result = await service.submitTier1('user-uuid', {
        ...VALID_DTO, id_type: KycIdType.PASSPORT, id_number: 'A12345678',
      });

      expect(result.message).toContain('verified');
    });

    it('verifies Drivers License successfully', async () => {
      prisma.kycVerification.findUnique.mockResolvedValue(null);
      kyc_provider.verifyDriversLicense.mockResolvedValue({ ...MATCH_RESULT, provider_reference: 'ABC123456789' });

      const result = await service.submitTier1('user-uuid', {
        ...VALID_DTO, id_type: KycIdType.DRIVERS_LICENSE, id_number: 'ABC123456789',
      });

      expect(result.message).toContain('verified');
    });

    it('accepts middle name in the name comparison', async () => {
      prisma.kycVerification.findUnique.mockResolvedValue(null);
      kyc_provider.verifyBvn.mockResolvedValue({ ...MATCH_RESULT, legal_name: 'Ada Chioma Obi' });

      const result = await service.submitTier1('user-uuid', {
        ...VALID_DTO, middle_name: 'Chioma',
      });

      expect(result.message).toContain('verified');
    });

    it('throws KYC_BIODATA_MISMATCH when name score is too low', async () => {
      prisma.kycVerification.findUnique.mockResolvedValue(null);
      kyc_provider.verifyBvn.mockResolvedValue({ ...MATCH_RESULT, legal_name: 'Emeka Nwosu' });

      await expect(service.submitTier1('user-uuid', VALID_DTO))
        .rejects.toMatchObject({ code: 'KYC_BIODATA_MISMATCH' });
    });

    it('throws KYC_BIODATA_MISMATCH when DOB does not match', async () => {
      prisma.kycVerification.findUnique.mockResolvedValue(null);
      kyc_provider.verifyBvn.mockResolvedValue({ ...MATCH_RESULT, date_of_birth: '1985-03-20' });

      await expect(service.submitTier1('user-uuid', VALID_DTO))
        .rejects.toMatchObject({ code: 'KYC_BIODATA_MISMATCH' });
    });

    it('passes when provider returns no DOB (skip DOB check)', async () => {
      prisma.kycVerification.findUnique.mockResolvedValue(null);
      kyc_provider.verifyBvn.mockResolvedValue({ legal_name: 'Ada Obi', provider_reference: '12345678901', raw_response: {} });

      const result = await service.submitTier1('user-uuid', VALID_DTO);

      expect(result.message).toContain('verified');
    });

    it('normalises DD-MM-YYYY DOB from provider before comparing', async () => {
      prisma.kycVerification.findUnique.mockResolvedValue(null);
      kyc_provider.verifyBvn.mockResolvedValue({ ...MATCH_RESULT, date_of_birth: '15-05-1990' });

      const result = await service.submitTier1('user-uuid', VALID_DTO);

      expect(result.message).toContain('verified');
    });

    it('throws KYC_ALREADY_VERIFIED when tier-1 already verified', async () => {
      prisma.kycVerification.findUnique.mockResolvedValue({ status: KycStatus.VERIFIED });

      await expect(service.submitTier1('user-uuid', VALID_DTO))
        .rejects.toMatchObject({ code: 'KYC_ALREADY_VERIFIED' });
    });

    it('throws KYC_PENDING when tier-1 is under review', async () => {
      prisma.kycVerification.findUnique.mockResolvedValue({ status: KycStatus.UNDER_REVIEW });

      await expect(service.submitTier1('user-uuid', VALID_DTO))
        .rejects.toMatchObject({ code: 'KYC_PENDING' });
    });

    it('throws KYC_PROVIDER_ERROR when provider call fails', async () => {
      prisma.kycVerification.findUnique.mockResolvedValue(null);
      kyc_provider.verifyBvn.mockRejectedValue(new Error('network error'));

      await expect(service.submitTier1('user-uuid', VALID_DTO))
        .rejects.toMatchObject({ code: 'KYC_PROVIDER_ERROR' });
    });
  });

  // ── revokeToTier ────────────────────────────────────────────────────────────

  describe('revokeToTier', () => {
    it('resets KYC to tier 0 — deletes all verifications', async () => {
      const delete_many = jest.fn().mockResolvedValue({ count: 1 });
      const user_update = jest.fn().mockResolvedValue({});
      prisma.$transaction.mockImplementation((fn: (tx: FakeTx) => Promise<unknown>) =>
        fn({ kycVerification: { upsert: jest.fn(), deleteMany: delete_many }, user: { update: user_update } }),
      );

      const result = await service.revokeToTier('user-uuid', { target_tier: 0 });

      expect(delete_many).toHaveBeenCalledWith({ where: { user_id: 'user-uuid', tier: { gt: 0 } } });
      expect(user_update).toHaveBeenCalledWith({ where: { id: 'user-uuid' }, data: { kyc_tier: 0 } });
      expect(result.message).toContain('reset');
    });

    it('revokes to tier 1 — deletes tiers above 1', async () => {
      const delete_many = jest.fn().mockResolvedValue({ count: 1 });
      const user_update = jest.fn().mockResolvedValue({});
      prisma.$transaction.mockImplementation((fn: (tx: FakeTx) => Promise<unknown>) =>
        fn({ kycVerification: { upsert: jest.fn(), deleteMany: delete_many }, user: { update: user_update } }),
      );

      const result = await service.revokeToTier('user-uuid', { target_tier: 1 });

      expect(delete_many).toHaveBeenCalledWith({ where: { user_id: 'user-uuid', tier: { gt: 1 } } });
      expect(result.message).toContain('tier 1');
    });
  });

  // ── getStatus ────────────────────────────────────────────────────────────────

  describe('getStatus', () => {
    it('returns current kyc_tier and verifications list', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({ kyc_tier: 1 });
      prisma.kycVerification.findMany.mockResolvedValue([
        { tier: 1, status: KycStatus.VERIFIED, verified_at: new Date() },
      ]);

      const result = await service.getStatus('user-uuid');

      expect(result.kyc_tier).toBe(1);
      expect(result.verifications).toHaveLength(1);
    });

    it('returns tier 0 for unverified user', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({ kyc_tier: 0 });
      prisma.kycVerification.findMany.mockResolvedValue([]);

      const result = await service.getStatus('user-uuid');

      expect(result.kyc_tier).toBe(0);
    });
  });
});
