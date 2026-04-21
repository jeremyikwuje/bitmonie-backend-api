import Decimal from 'decimal.js';
import { Test, TestingModule } from '@nestjs/testing';
import { DisbursementRail, DisbursementStatus, DisbursementType } from '@prisma/client';
import { DisbursementsService } from '@/modules/disbursements/disbursements.service';
import { PrismaService } from '@/database/prisma.service';

const LOAN_ID   = 'loan-uuid-001';
const USER_ID   = 'user-uuid-001';
const DISB_ID   = 'disb-uuid-001';

const CREATE_PARAMS = {
  user_id:        USER_ID,
  source_id:      LOAN_ID,
  amount:         new Decimal('300000'),
  currency:       'NGN',
  disbursement_rail: DisbursementRail.BANK_TRANSFER,
  provider_name:  'GTBank',
  account_unique: '0123456789',
  account_name:   'Ada Obi',
};

const DB_DISBURSEMENT = {
  id:               DISB_ID,
  user_id:          USER_ID,
  disbursement_type: DisbursementType.LOAN,
  disbursement_rail: DisbursementRail.BANK_TRANSFER,
  source_type:      DisbursementType.LOAN,
  source_id:        LOAN_ID,
  amount:           new Decimal('300000'),
  currency:         'NGN',
  provider_name:    'GTBank',
  account_unique:   '0123456789',
  account_name:     'Ada Obi',
  status:           DisbursementStatus.PENDING,
  failure_reason:   null,
  created_at:       new Date(),
  updated_at:       new Date(),
};

function make_prisma() {
  return {
    disbursement: {
      create:    jest.fn().mockResolvedValue(DB_DISBURSEMENT),
      findFirst: jest.fn(),
      update:    jest.fn(),
    },
  };
}

describe('DisbursementsService', () => {
  let service: DisbursementsService;
  let prisma: ReturnType<typeof make_prisma>;

  beforeEach(async () => {
    prisma = make_prisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DisbursementsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(DisbursementsService);
  });

  // ── createForLoan ────────────────────────────────────────────────────────────

  describe('createForLoan', () => {
    it('creates a Disbursement with PENDING status and correct fields', async () => {
      const result = await service.createForLoan(CREATE_PARAMS);

      expect(prisma.disbursement.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          user_id:           USER_ID,
          disbursement_type: DisbursementType.LOAN,
          source_type:       DisbursementType.LOAN,
          source_id:         LOAN_ID,
          disbursement_rail: DisbursementRail.BANK_TRANSFER,
          amount:            CREATE_PARAMS.amount,
          currency:          'NGN',
          provider_name:     'GTBank',
          account_unique:    '0123456789',
          account_name:      'Ada Obi',
          status:            DisbursementStatus.PENDING,
        }),
      });
      expect(result.id).toBe(DISB_ID);
      expect(result.status).toBe(DisbursementStatus.PENDING);
    });

    it('snapshots destination fields — does not reference disbursement_account_id', async () => {
      await service.createForLoan(CREATE_PARAMS);

      const call = prisma.disbursement.create.mock.calls[0][0];
      expect(call.data).not.toHaveProperty('disbursement_account_id');
    });

    it('sets disbursement_type and source_type both to LOAN', async () => {
      await service.createForLoan(CREATE_PARAMS);

      const { data } = prisma.disbursement.create.mock.calls[0][0];
      expect(data.disbursement_type).toBe(DisbursementType.LOAN);
      expect(data.source_type).toBe(DisbursementType.LOAN);
    });
  });

  // ── findById ─────────────────────────────────────────────────────────────────

  describe('findById', () => {
    it('returns null when disbursement is not found', async () => {
      prisma.disbursement.findFirst.mockResolvedValue(null);
      const result = await service.findById(DISB_ID);
      expect(result).toBeNull();
    });

    it('returns the disbursement when found', async () => {
      prisma.disbursement.findFirst.mockResolvedValue(DB_DISBURSEMENT);
      const result = await service.findById(DISB_ID);
      expect(result?.id).toBe(DISB_ID);
    });
  });

  // ── markProcessing / markSuccessful / markFailed ──────────────────────────────

  describe('markProcessing', () => {
    it('updates status to PROCESSING', async () => {
      prisma.disbursement.update.mockResolvedValue({ ...DB_DISBURSEMENT, status: DisbursementStatus.PROCESSING });
      const result = await service.markProcessing(DISB_ID);
      expect(prisma.disbursement.update).toHaveBeenCalledWith({
        where: { id: DISB_ID },
        data: { status: DisbursementStatus.PROCESSING },
      });
      expect(result.status).toBe(DisbursementStatus.PROCESSING);
    });
  });

  describe('markSuccessful', () => {
    it('updates status to SUCCESSFUL', async () => {
      prisma.disbursement.update.mockResolvedValue({ ...DB_DISBURSEMENT, status: DisbursementStatus.SUCCESSFUL });
      const result = await service.markSuccessful(DISB_ID);
      expect(prisma.disbursement.update).toHaveBeenCalledWith({
        where: { id: DISB_ID },
        data: { status: DisbursementStatus.SUCCESSFUL },
      });
      expect(result.status).toBe(DisbursementStatus.SUCCESSFUL);
    });
  });

  describe('markFailed', () => {
    it('updates status to FAILED with failure_reason', async () => {
      prisma.disbursement.update.mockResolvedValue({
        ...DB_DISBURSEMENT,
        status: DisbursementStatus.FAILED,
        failure_reason: 'Insufficient funds',
      });
      const result = await service.markFailed(DISB_ID, 'Insufficient funds');
      expect(prisma.disbursement.update).toHaveBeenCalledWith({
        where: { id: DISB_ID },
        data: { status: DisbursementStatus.FAILED, failure_reason: 'Insufficient funds' },
      });
      expect(result.status).toBe(DisbursementStatus.FAILED);
    });
  });
});
