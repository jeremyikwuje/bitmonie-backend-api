import Decimal from 'decimal.js';
import { Test, TestingModule } from '@nestjs/testing';
import { mock, MockProxy } from 'jest-mock-extended';
import { PaymentNetwork, PaymentRequestStatus } from '@prisma/client';
import { InflowsService } from '@/modules/inflows/inflows.service';
import { PaymentRequestsService } from '@/modules/payment-requests/payment-requests.service';
import { PrismaService } from '@/database/prisma.service';

const USER_ID    = 'user-uuid-001';
const PR_ID      = 'pr-uuid-001';
const INFLOW_ID  = 'inflow-uuid-001';

const INGEST_PARAMS = {
  asset:              'SAT',
  amount:             new Decimal('386598'),
  currency:           'SAT',
  network:            PaymentNetwork.LIGHTNING,
  receiving_address:  'pay_hash_001',
  provider_reference: 'pay_hash_001',
  provider_response:  { payment_hash: 'pay_hash_001' } as Record<string, unknown>,
};

const DB_INFLOW = {
  id:                 INFLOW_ID,
  user_id:            null,
  asset:              'SAT',
  amount:             new Decimal('386598'),
  currency:           'SAT',
  network:            PaymentNetwork.LIGHTNING,
  receiving_address:  'pay_hash_001',
  sender_address:     null,
  provider_reference: 'pay_hash_001',
  confirmations_required: null,
  confirmations_received: 0,
  block_number:       null,
  block_timestamp:    null,
  is_matched:         false,
  matched_at:         null,
  source_type:        null,
  source_id:          null,
  provider_response:  { payment_hash: 'pay_hash_001' },
  created_at:         new Date(),
  updated_at:         new Date(),
};

const PENDING_PR = {
  id:                 PR_ID,
  user_id:            USER_ID,
  request_type:       'COLLATERAL',
  source_type:        'LOAN',
  source_id:          'loan-uuid-001',
  asset:              'SAT',
  network:            PaymentNetwork.LIGHTNING,
  expected_amount:    new Decimal('386598'),
  currency:           'SAT',
  receiving_address:  'pay_hash_001',
  payment_request:    'lnbc300000stub',
  provider_reference: 'pay_hash_001',
  status:             PaymentRequestStatus.PENDING,
  expires_at:         new Date(Date.now() + 1800_000),
  paid_at:            null,
  inflow_id:          null,
};

function make_prisma() {
  return {
    inflow: {
      create: jest.fn().mockResolvedValue(DB_INFLOW),
    },
  };
}

describe('InflowsService', () => {
  let service: InflowsService;
  let prisma: ReturnType<typeof make_prisma>;
  let payment_requests: MockProxy<PaymentRequestsService>;

  beforeEach(async () => {
    prisma = make_prisma();
    payment_requests = mock<PaymentRequestsService>();
    payment_requests.findPendingByReceivingAddress.mockResolvedValue(null);
    payment_requests.matchInflow.mockResolvedValue(PENDING_PR as never);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InflowsService,
        { provide: PrismaService,           useValue: prisma },
        { provide: PaymentRequestsService,  useValue: payment_requests },
      ],
    }).compile();

    service = module.get(InflowsService);
  });

  // ── ingest ────────────────────────────────────────────────────────────────────

  describe('ingest', () => {
    it('creates an Inflow row with the given fields', async () => {
      await service.ingest(INGEST_PARAMS);

      expect(prisma.inflow.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          asset:              'SAT',
          amount:             new Decimal('386598'),
          currency:           'SAT',
          network:            PaymentNetwork.LIGHTNING,
          receiving_address:  'pay_hash_001',
          provider_reference: 'pay_hash_001',
          is_matched:         false,
        }),
      });
    });

    it('stores provider_response on the Inflow row', async () => {
      await service.ingest(INGEST_PARAMS);

      const { data } = prisma.inflow.create.mock.calls[0][0];
      expect(data.provider_response).toEqual({ payment_hash: 'pay_hash_001' });
    });

    it('looks up a pending PaymentRequest by receiving_address', async () => {
      await service.ingest(INGEST_PARAMS);

      expect(payment_requests.findPendingByReceivingAddress).toHaveBeenCalledWith('pay_hash_001');
    });

    it('calls matchInflow when a PaymentRequest is found', async () => {
      payment_requests.findPendingByReceivingAddress.mockResolvedValue(PENDING_PR as never);

      await service.ingest(INGEST_PARAMS);

      expect(payment_requests.matchInflow).toHaveBeenCalledWith(
        expect.objectContaining({
          payment_request: PENDING_PR,
          inflow: expect.objectContaining({ id: INFLOW_ID }),
        }),
      );
    });

    it('does not call matchInflow when no PaymentRequest is found', async () => {
      payment_requests.findPendingByReceivingAddress.mockResolvedValue(null);

      await service.ingest(INGEST_PARAMS);

      expect(payment_requests.matchInflow).not.toHaveBeenCalled();
    });

    it('returns the created inflow and matched payment_request', async () => {
      payment_requests.findPendingByReceivingAddress.mockResolvedValue(PENDING_PR as never);

      const result = await service.ingest(INGEST_PARAMS);

      expect(result.inflow.id).toBe(INFLOW_ID);
      expect(result.payment_request?.id).toBe(PR_ID);
    });

    it('returns null payment_request when no match found', async () => {
      payment_requests.findPendingByReceivingAddress.mockResolvedValue(null);

      const result = await service.ingest(INGEST_PARAMS);

      expect(result.payment_request).toBeNull();
    });

    it('is idempotent — returns existing inflow on duplicate provider_reference', async () => {
      const duplicate_error = Object.assign(new Error('Unique constraint'), { code: 'P2002' });
      const existing_inflow = { ...DB_INFLOW, is_matched: true };
      prisma.inflow.create
        .mockRejectedValueOnce(duplicate_error);

      // When P2002 is thrown, service should find and return the existing inflow
      // We mock the second call (via findFirst on the prisma client) via a cast
      const prisma_with_find = prisma as typeof prisma & { inflow: { findUniqueOrThrow: jest.Mock } };
      prisma_with_find.inflow.findUniqueOrThrow = jest.fn().mockResolvedValue(existing_inflow);

      const result = await service.ingest(INGEST_PARAMS);
      expect(result.inflow.id).toBe(INFLOW_ID);
    });
  });
});
