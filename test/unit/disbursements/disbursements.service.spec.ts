import Decimal from 'decimal.js';
import { Test, TestingModule } from '@nestjs/testing';
import { DisbursementRail, DisbursementStatus, DisbursementType } from '@prisma/client';
import { DisbursementsService } from '@/modules/disbursements/disbursements.service';
import { PrismaService } from '@/database/prisma.service';

const LOAN_ID   = 'loan-uuid-001';
const USER_ID   = 'user-uuid-001';
const DISB_ID   = 'disb-uuid-001';
const OPS_USER_ID = 'ops-uuid-001';

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
  id:                       DISB_ID,
  user_id:                  USER_ID,
  disbursement_type:        DisbursementType.LOAN,
  disbursement_rail:        DisbursementRail.BANK_TRANSFER,
  source_type:              DisbursementType.LOAN,
  source_id:                LOAN_ID,
  amount:                   new Decimal('300000'),
  currency:                 'NGN',
  provider_name:            'GTBank',
  account_unique:           '0123456789',
  account_name:             'Ada Obi',
  status:                   DisbursementStatus.PENDING,
  failure_reason:           null,
  on_hold_at:               null,
  on_hold_alerted_at:       null,
  cancelled_at:             null,
  cancelled_by_ops_user_id: null,
  cancellation_reason:      null,
  created_at:               new Date(),
  updated_at:               new Date(),
};

function make_prisma() {
  return {
    disbursement: {
      create:              jest.fn().mockResolvedValue(DB_DISBURSEMENT),
      findFirst:           jest.fn(),
      findUniqueOrThrow:   jest.fn(),
      update:              jest.fn(),
      updateMany:          jest.fn(),
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

  // ── markProcessing / markSuccessful ──────────────────────────────────────────

  describe('markProcessing', () => {
    it('updates status to PROCESSING and clears on_hold bookkeeping', async () => {
      prisma.disbursement.update.mockResolvedValue({ ...DB_DISBURSEMENT, status: DisbursementStatus.PROCESSING });
      const result = await service.markProcessing(DISB_ID);
      expect(prisma.disbursement.update).toHaveBeenCalledWith({
        where: { id: DISB_ID },
        data: {
          status:             DisbursementStatus.PROCESSING,
          on_hold_at:         null,
          on_hold_alerted_at: null,
        },
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

  // ── markOnHold ───────────────────────────────────────────────────────────────

  describe('markOnHold', () => {
    it('reports first_transition=true on the first move into ON_HOLD', async () => {
      prisma.disbursement.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.markOnHold(DISB_ID, 'Bank declined');

      expect(prisma.disbursement.updateMany).toHaveBeenCalledWith({
        where: { id: DISB_ID, status: { not: DisbursementStatus.ON_HOLD } },
        data: expect.objectContaining({
          status:         DisbursementStatus.ON_HOLD,
          failure_reason: 'Bank declined',
        }),
      });
      expect(result.is_first_transition).toBe(true);
      expect(result.on_hold_at).toBeInstanceOf(Date);
    });

    it('reports first_transition=false when row is already ON_HOLD (returns existing on_hold_at)', async () => {
      const existing_on_hold_at = new Date('2026-04-25T10:00:00Z');
      prisma.disbursement.updateMany.mockResolvedValue({ count: 0 });
      prisma.disbursement.findUniqueOrThrow.mockResolvedValue({ on_hold_at: existing_on_hold_at });

      const result = await service.markOnHold(DISB_ID, 'Repeat failure');

      expect(result.is_first_transition).toBe(false);
      expect(result.on_hold_at).toEqual(existing_on_hold_at);
    });
  });

  // ── markOnHoldAlerted ────────────────────────────────────────────────────────

  describe('markOnHoldAlerted', () => {
    it('stamps on_hold_alerted_at', async () => {
      prisma.disbursement.update.mockResolvedValue({ ...DB_DISBURSEMENT });

      await service.markOnHoldAlerted(DISB_ID);

      const call = prisma.disbursement.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: DISB_ID });
      expect(call.data.on_hold_alerted_at).toBeInstanceOf(Date);
    });
  });

  // ── markCancelled ────────────────────────────────────────────────────────────

  describe('markCancelled', () => {
    it('updates status to CANCELLED with the ops audit pair (cancelled_at + cancelled_by_ops_user_id + reason)', async () => {
      prisma.disbursement.update.mockResolvedValue({ ...DB_DISBURSEMENT, status: DisbursementStatus.CANCELLED });

      await service.markCancelled({
        disbursement_id:          DISB_ID,
        cancelled_by_ops_user_id: OPS_USER_ID,
        cancellation_reason:      'Wrong account number',
      });

      const call = prisma.disbursement.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: DISB_ID });
      expect(call.data).toMatchObject({
        status:                   DisbursementStatus.CANCELLED,
        cancelled_by_ops_user_id: OPS_USER_ID,
        cancellation_reason:      'Wrong account number',
      });
      expect(call.data.cancelled_at).toBeInstanceOf(Date);
    });

    it('uses the supplied tx client when one is passed', async () => {
      const tx_client = {
        disbursement: { update: jest.fn().mockResolvedValue({ ...DB_DISBURSEMENT, status: DisbursementStatus.CANCELLED }) },
      };

      await service.markCancelled(
        { disbursement_id: DISB_ID, cancelled_by_ops_user_id: OPS_USER_ID, cancellation_reason: 'Manual cancel' },
        tx_client as never,
      );

      expect(tx_client.disbursement.update).toHaveBeenCalled();
      expect(prisma.disbursement.update).not.toHaveBeenCalled();
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
});
