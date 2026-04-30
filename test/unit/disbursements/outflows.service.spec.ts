import Decimal from 'decimal.js';
import { Test, TestingModule } from '@nestjs/testing';
import { mock, MockProxy } from 'jest-mock-extended';
import {
  DisbursementRail,
  DisbursementStatus,
  DisbursementType,
  OutflowStatus,
} from '@prisma/client';
import { OutflowsService } from '@/modules/disbursements/outflows.service';
import { DisbursementsService } from '@/modules/disbursements/disbursements.service';
import { DisbursementRouter } from '@/modules/disbursements/disbursement-router.service';
import { OpsAlertsService } from '@/modules/ops-alerts/ops-alerts.service';
import { LoanNotificationsService } from '@/modules/loan-notifications/loan-notifications.service';
import {
  DisbursementNotFoundException,
  DisbursementNotOnHoldException,
} from '@/common/errors/bitmonie.errors';
import type { DisbursementProvider } from '@/modules/disbursements/disbursement.provider.interface';
import { PrismaService } from '@/database/prisma.service';

const DISB_ID   = 'disb-uuid-001';
const OUTFLOW_ID = 'outflow-uuid-001';
const USER_ID   = 'user-uuid-001';

const DISBURSEMENT = {
  id:                       DISB_ID,
  user_id:                  USER_ID,
  disbursement_type:        DisbursementType.LOAN,
  disbursement_rail:        DisbursementRail.BANK_TRANSFER,
  source_type:              DisbursementType.LOAN,
  source_id:                'loan-uuid-001',
  amount:                   new Decimal('300000'),
  currency:                 'NGN',
  provider_name:            'GTBank',
  provider_code:            '058',
  account_unique:           '0123456789',
  account_name:             'Ada Obi',
  status:                   DisbursementStatus.PENDING,
  failure_reason:           null,
  on_hold_at:               null,
  on_hold_alerted_at:       null,
  cancelled_at:             null,
  cancelled_by_ops_user_id: null,
  cancellation_reason:      null,
  outflows:                 [],
  created_at:               new Date(),
  updated_at:               new Date(),
};

const OUTFLOW_ROW = {
  id:                 OUTFLOW_ID,
  disbursement_id:    DISB_ID,
  user_id:            USER_ID,
  attempt_number:     1,
  provider:           'palmpay',
  provider_reference: `outflow-1-${DISB_ID}`,
  provider_tx_id:     null,
  provider_response:  null,
  status:             OutflowStatus.PENDING,
  failure_reason:     null,
  failure_code:       null,
  initiated_at:       null,
  confirmed_at:       null,
  created_at:         new Date(),
  updated_at:         new Date(),
};

function make_prisma() {
  return {
    disbursement: {
      findFirst: jest.fn(),
      update:    jest.fn(),
    },
    outflow: {
      create:    jest.fn().mockResolvedValue(OUTFLOW_ROW),
      findFirst: jest.fn(),
      update:    jest.fn(),
    },
  };
}

describe('OutflowsService', () => {
  let service: OutflowsService;
  let disbursements_service: MockProxy<DisbursementsService>;
  let router: MockProxy<DisbursementRouter>;
  let provider: MockProxy<DisbursementProvider>;
  let ops_alerts: MockProxy<OpsAlertsService>;
  let loan_notifications: MockProxy<LoanNotificationsService>;
  let prisma: ReturnType<typeof make_prisma>;

  beforeEach(async () => {
    prisma = make_prisma();
    disbursements_service = mock<DisbursementsService>();
    router = mock<DisbursementRouter>();
    provider = mock<DisbursementProvider>();
    ops_alerts = mock<OpsAlertsService>();
    loan_notifications = mock<LoanNotificationsService>();

    router.forRoute.mockReturnValue(provider);
    disbursements_service.findById.mockResolvedValue(DISBURSEMENT as never);
    disbursements_service.markProcessing.mockResolvedValue({ ...DISBURSEMENT, status: DisbursementStatus.PROCESSING } as never);
    disbursements_service.markSuccessful.mockResolvedValue({ ...DISBURSEMENT, status: DisbursementStatus.SUCCESSFUL } as never);
    disbursements_service.markOnHold.mockResolvedValue({ is_first_transition: true, on_hold_at: new Date() });
    disbursements_service.markOnHoldAlerted.mockResolvedValue();

    provider.initiateTransfer.mockResolvedValue({
      provider_txn_id: 'ext_txn_001',
      provider_response: { status: 'queued' },
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutflowsService,
        { provide: PrismaService,         useValue: prisma },
        { provide: DisbursementsService,  useValue: disbursements_service },
        { provide: DisbursementRouter,    useValue: router },
        { provide: OpsAlertsService,      useValue: ops_alerts },
        { provide: LoanNotificationsService, useValue: loan_notifications },
      ],
    }).compile();

    service = module.get(OutflowsService);
  });

  // ── dispatch ─────────────────────────────────────────────────────────────────

  describe('dispatch', () => {
    it('creates an Outflow row with attempt_number 1 on first dispatch', async () => {
      await service.dispatch(DISB_ID);

      expect(prisma.outflow.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          disbursement_id:    DISB_ID,
          user_id:            USER_ID,
          attempt_number:     1,
          provider_reference: `outflow-1-${DISB_ID}`,
          status:             OutflowStatus.PENDING,
        }),
      });
    });

    it('marks Disbursement as PROCESSING after creating Outflow', async () => {
      await service.dispatch(DISB_ID);
      expect(disbursements_service.markProcessing).toHaveBeenCalledWith(DISB_ID);
    });

    it('updates Outflow with provider_tx_id after successful initiation', async () => {
      await service.dispatch(DISB_ID);

      expect(prisma.outflow.update).toHaveBeenCalledWith({
        where: { id: OUTFLOW_ID },
        data: expect.objectContaining({
          provider_tx_id:    'ext_txn_001',
          provider_response: { status: 'queued' },
          status:            OutflowStatus.PROCESSING,
          initiated_at:      expect.any(Date),
        }),
      });
    });

    it('on provider failure: marks Outflow FAILED, calls markOnHold (NOT markFailed), and pages ops on first transition', async () => {
      provider.initiateTransfer.mockRejectedValue(new Error('Provider timeout'));
      // First findById returns the original; second (inside _markOnHoldAndMaybeAlert) returns the row with the new outflow
      disbursements_service.findById
        .mockResolvedValueOnce(DISBURSEMENT as never)
        .mockResolvedValueOnce({
          ...DISBURSEMENT,
          status: DisbursementStatus.ON_HOLD,
          outflows: [{ ...OUTFLOW_ROW, status: OutflowStatus.FAILED, attempt_number: 1 }],
        } as never);

      await service.dispatch(DISB_ID);

      expect(prisma.outflow.update).toHaveBeenCalledWith({
        where: { id: OUTFLOW_ID },
        data: expect.objectContaining({
          status:         OutflowStatus.FAILED,
          failure_reason: expect.stringContaining('Provider timeout'),
        }),
      });
      expect(disbursements_service.markOnHold).toHaveBeenCalledWith(DISB_ID, expect.stringContaining('Provider timeout'));
      expect(ops_alerts.alertDisbursementOnHold).toHaveBeenCalledWith(expect.objectContaining({
        disbursement_id: DISB_ID,
        attempt_number:  1,
        failure_reason:  expect.stringContaining('Provider timeout'),
      }));
      expect(disbursements_service.markOnHoldAlerted).toHaveBeenCalledWith(DISB_ID);
    });

    it('on provider failure when already ON_HOLD: suppresses immediate alert (digest will surface it)', async () => {
      provider.initiateTransfer.mockRejectedValue(new Error('Provider timeout 2'));
      disbursements_service.markOnHold.mockResolvedValue({
        is_first_transition: false,
        on_hold_at:          new Date('2026-04-25T10:00:00Z'),
      });

      await service.dispatch(DISB_ID);

      expect(disbursements_service.markOnHold).toHaveBeenCalled();
      expect(ops_alerts.alertDisbursementOnHold).not.toHaveBeenCalled();
      expect(disbursements_service.markOnHoldAlerted).not.toHaveBeenCalled();
    });

    it('skips dispatch if an active Outflow already exists (PROCESSING)', async () => {
      disbursements_service.findById.mockResolvedValue({
        ...DISBURSEMENT,
        status: DisbursementStatus.PROCESSING,
        outflows: [{ ...OUTFLOW_ROW, status: OutflowStatus.PROCESSING }],
      } as never);

      await service.dispatch(DISB_ID);

      expect(prisma.outflow.create).not.toHaveBeenCalled();
      expect(provider.initiateTransfer).not.toHaveBeenCalled();
    });

    it('skips dispatch if Disbursement is already SUCCESSFUL', async () => {
      disbursements_service.findById.mockResolvedValue({
        ...DISBURSEMENT,
        status: DisbursementStatus.SUCCESSFUL,
        outflows: [],
      } as never);

      await service.dispatch(DISB_ID);

      expect(prisma.outflow.create).not.toHaveBeenCalled();
    });

    it('skips dispatch if Disbursement is CANCELLED', async () => {
      disbursements_service.findById.mockResolvedValue({
        ...DISBURSEMENT,
        status: DisbursementStatus.CANCELLED,
        outflows: [],
      } as never);

      await service.dispatch(DISB_ID);

      expect(prisma.outflow.create).not.toHaveBeenCalled();
    });

    it('throws DisbursementNotFoundException when the disbursement is missing', async () => {
      disbursements_service.findById.mockResolvedValue(null);
      await expect(service.dispatch(DISB_ID)).rejects.toBeInstanceOf(DisbursementNotFoundException);
    });
  });

  // ── retryDispatch ─────────────────────────────────────────────────────────────

  describe('retryDispatch', () => {
    it('creates a new Outflow with attempt_number incremented by 1', async () => {
      const failed_outflow = { ...OUTFLOW_ROW, attempt_number: 1, status: OutflowStatus.FAILED };
      disbursements_service.findById.mockResolvedValue({
        ...DISBURSEMENT,
        status: DisbursementStatus.ON_HOLD,
        outflows: [failed_outflow],
      } as never);

      await service.retryDispatch(DISB_ID);

      expect(prisma.outflow.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          attempt_number:     2,
          provider_reference: `outflow-2-${DISB_ID}`,
        }),
      });
    });

    it('never updates the failed Outflow row — always creates a new one', async () => {
      const failed_outflow = { ...OUTFLOW_ROW, id: 'outflow-old-001', attempt_number: 1, status: OutflowStatus.FAILED };
      const new_outflow    = { ...OUTFLOW_ROW, id: 'outflow-new-002', attempt_number: 2, status: OutflowStatus.PENDING };
      prisma.outflow.create.mockResolvedValue(new_outflow);
      disbursements_service.findById.mockResolvedValue({
        ...DISBURSEMENT,
        status: DisbursementStatus.ON_HOLD,
        outflows: [failed_outflow],
      } as never);

      await service.retryDispatch(DISB_ID);

      const update_calls = prisma.outflow.update.mock.calls;
      for (const [args] of update_calls) {
        expect(args.where.id).not.toBe(failed_outflow.id);
      }
    });

    it('throws DisbursementNotOnHoldException if Disbursement is not ON_HOLD', async () => {
      disbursements_service.findById.mockResolvedValue({
        ...DISBURSEMENT,
        status: DisbursementStatus.PROCESSING,
        outflows: [],
      } as never);

      await expect(service.retryDispatch(DISB_ID)).rejects.toBeInstanceOf(DisbursementNotOnHoldException);
    });

    it('throws DisbursementNotFoundException if the disbursement is missing', async () => {
      disbursements_service.findById.mockResolvedValue(null);
      await expect(service.retryDispatch(DISB_ID)).rejects.toBeInstanceOf(DisbursementNotFoundException);
    });
  });

  // ── handleSuccess ─────────────────────────────────────────────────────────────

  describe('handleSuccess', () => {
    it('marks Outflow SUCCESSFUL and Disbursement SUCCESSFUL', async () => {
      prisma.outflow.update.mockResolvedValue({ ...OUTFLOW_ROW, status: OutflowStatus.SUCCESSFUL });

      await service.handleSuccess(OUTFLOW_ID, DISB_ID, 'ext_txn_002', { final: true });

      expect(prisma.outflow.update).toHaveBeenCalledWith({
        where: { id: OUTFLOW_ID },
        data: expect.objectContaining({
          status:            OutflowStatus.SUCCESSFUL,
          provider_tx_id:    'ext_txn_002',
          provider_response: { final: true },
          confirmed_at:      expect.any(Date),
        }),
      });
      expect(disbursements_service.markSuccessful).toHaveBeenCalledWith(DISB_ID);
    });
  });

  // ── handleFailure ─────────────────────────────────────────────────────────────

  describe('handleFailure', () => {
    it('marks Outflow FAILED and parent Disbursement ON_HOLD with first-transition alert', async () => {
      prisma.outflow.update.mockResolvedValue({ ...OUTFLOW_ROW, status: OutflowStatus.FAILED });
      disbursements_service.findById.mockResolvedValue({
        ...DISBURSEMENT,
        status: DisbursementStatus.ON_HOLD,
        outflows: [{ ...OUTFLOW_ROW, status: OutflowStatus.FAILED, attempt_number: 1 }],
      } as never);

      await service.handleFailure(OUTFLOW_ID, DISB_ID, 'Declined by bank', 'BANK_DECLINED');

      expect(prisma.outflow.update).toHaveBeenCalledWith({
        where: { id: OUTFLOW_ID },
        data: expect.objectContaining({
          status:         OutflowStatus.FAILED,
          failure_reason: 'Declined by bank',
          failure_code:   'BANK_DECLINED',
        }),
      });
      expect(disbursements_service.markOnHold).toHaveBeenCalledWith(DISB_ID, 'Declined by bank');
      expect(ops_alerts.alertDisbursementOnHold).toHaveBeenCalledWith(expect.objectContaining({
        disbursement_id: DISB_ID,
        failure_reason:  'Declined by bank',
        failure_code:    'BANK_DECLINED',
      }));
    });

    it('does not page ops when disbursement was already ON_HOLD', async () => {
      prisma.outflow.update.mockResolvedValue({ ...OUTFLOW_ROW, status: OutflowStatus.FAILED });
      disbursements_service.markOnHold.mockResolvedValue({
        is_first_transition: false,
        on_hold_at:          new Date('2026-04-25T10:00:00Z'),
      });

      await service.handleFailure(OUTFLOW_ID, DISB_ID, 'Declined again');

      expect(disbursements_service.markOnHold).toHaveBeenCalled();
      expect(ops_alerts.alertDisbursementOnHold).not.toHaveBeenCalled();
    });
  });
});
