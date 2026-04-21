import Decimal from 'decimal.js';
import { Test, TestingModule } from '@nestjs/testing';
import { mock, MockProxy } from 'jest-mock-extended';
import {
  PaymentNetwork,
  PaymentRequestStatus,
  PaymentRequestType,
} from '@prisma/client';
import { PaymentRequestsService } from '@/modules/payment-requests/payment-requests.service';
import { COLLATERAL_PROVIDER } from '@/modules/payment-requests/collateral.provider.interface';
import type { CollateralProvider } from '@/modules/payment-requests/collateral.provider.interface';
import { PrismaService } from '@/database/prisma.service';
import { REDIS_CLIENT } from '@/database/redis.module';

const USER_ID   = 'user-uuid-001';
const LOAN_ID   = 'loan-uuid-001';
const PR_ID     = 'pr-uuid-001';
const INFLOW_ID = 'inflow-uuid-001';

const EXPIRES_AT = new Date(Date.now() + 1800 * 1000);

const PROVIDER_RESULT = {
  provider_reference: 'pay_hash_001',
  payment_request:    'lnbc300000stub',
  receiving_address:  'pay_hash_001',
  expires_at:         EXPIRES_AT,
};

const DB_PAYMENT_REQUEST = {
  id:                 PR_ID,
  user_id:            USER_ID,
  request_type:       PaymentRequestType.COLLATERAL,
  source_type:        'LOAN',
  source_id:          LOAN_ID,
  asset:              'SAT',
  network:            PaymentNetwork.LIGHTNING,
  expected_amount:    new Decimal('386598'),
  currency:           'SAT',
  receiving_address:  'pay_hash_001',
  payment_request:    'lnbc300000stub',
  provider_reference: 'pay_hash_001',
  status:             PaymentRequestStatus.PENDING,
  expires_at:         EXPIRES_AT,
  paid_at:            null,
  inflow_id:          null,
  created_at:         new Date(),
  updated_at:         new Date(),
};

function make_prisma() {
  return {
    paymentRequest: {
      create:    jest.fn().mockResolvedValue(DB_PAYMENT_REQUEST),
      findFirst: jest.fn(),
      update:    jest.fn(),
    },
    inflow: {
      update:    jest.fn(),
    },
    $transaction: jest.fn().mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          paymentRequest: {
            update: jest.fn().mockResolvedValue({ ...DB_PAYMENT_REQUEST, status: PaymentRequestStatus.PAID, inflow_id: INFLOW_ID }),
          },
          inflow: {
            update: jest.fn().mockResolvedValue({}),
          },
        }),
    ),
  };
}

function make_redis() {
  return {
    set:  jest.fn().mockResolvedValue('OK'),
    get:  jest.fn().mockResolvedValue(null),
    del:  jest.fn().mockResolvedValue(1),
  };
}

describe('PaymentRequestsService', () => {
  let service: PaymentRequestsService;
  let prisma: ReturnType<typeof make_prisma>;
  let redis: ReturnType<typeof make_redis>;
  let provider: MockProxy<CollateralProvider>;

  beforeEach(async () => {
    prisma = make_prisma();
    redis  = make_redis();
    provider = mock<CollateralProvider>();
    provider.createPaymentRequest.mockResolvedValue(PROVIDER_RESULT);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentRequestsService,
        { provide: PrismaService,        useValue: prisma },
        { provide: REDIS_CLIENT,         useValue: redis },
        { provide: COLLATERAL_PROVIDER,  useValue: provider },
      ],
    }).compile();

    service = module.get(PaymentRequestsService);
  });

  // ── create ────────────────────────────────────────────────────────────────────

  describe('create', () => {
    const CREATE_PARAMS = {
      user_id:          USER_ID,
      source_type:      'LOAN' as const,
      source_id:        LOAN_ID,
      collateral_sat:   BigInt(386598),
      memo:             'Bitmonie loan collateral',
    };

    it('calls CollateralProvider.createPaymentRequest with correct params', async () => {
      await service.create(CREATE_PARAMS);

      expect(provider.createPaymentRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          amount_sat:     BigInt(386598),
          memo:           'Bitmonie loan collateral',
        }),
      );
    });

    it('saves PaymentRequest to DB with PENDING status', async () => {
      await service.create(CREATE_PARAMS);

      expect(prisma.paymentRequest.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          user_id:            USER_ID,
          request_type:       PaymentRequestType.COLLATERAL,
          source_type:        'LOAN',
          source_id:          LOAN_ID,
          asset:              'SAT',
          network:            PaymentNetwork.LIGHTNING,
          receiving_address:  'pay_hash_001',
          payment_request:    'lnbc300000stub',
          provider_reference: 'pay_hash_001',
          status:             PaymentRequestStatus.PENDING,
          expires_at:         EXPIRES_AT,
        }),
      });
    });

    it('caches receiving_address in Redis', async () => {
      await service.create(CREATE_PARAMS);

      expect(redis.set).toHaveBeenCalledWith(
        `payment_request:pending:pay_hash_001`,
        PR_ID,
        'EX',
        expect.any(Number),
      );
    });

    it('sets Redis TTL to approximately expires_at + 5 min from now', async () => {
      await service.create(CREATE_PARAMS);

      const [, , , ttl] = redis.set.mock.calls[0];
      // TTL should be between ~1800s and ~2100s (30min + 5min grace)
      expect(ttl).toBeGreaterThan(1800);
      expect(ttl).toBeLessThanOrEqual(2100);
    });

    it('returns the created PaymentRequest', async () => {
      const result = await service.create(CREATE_PARAMS);
      expect(result.id).toBe(PR_ID);
    });
  });

  // ── findPendingByReceivingAddress ─────────────────────────────────────────────

  describe('findPendingByReceivingAddress', () => {
    it('returns PaymentRequest from DB when Redis miss', async () => {
      redis.get.mockResolvedValue(null);
      prisma.paymentRequest.findFirst.mockResolvedValue(DB_PAYMENT_REQUEST);

      const result = await service.findPendingByReceivingAddress('pay_hash_001');
      expect(result?.id).toBe(PR_ID);
    });

    it('uses Redis cached ID to fetch PaymentRequest (avoids duplicate DB lookup)', async () => {
      redis.get.mockResolvedValue(PR_ID);
      prisma.paymentRequest.findFirst.mockResolvedValue(DB_PAYMENT_REQUEST);

      await service.findPendingByReceivingAddress('pay_hash_001');
      expect(prisma.paymentRequest.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: PR_ID }) }),
      );
    });

    it('returns null when not found in Redis or DB', async () => {
      redis.get.mockResolvedValue(null);
      prisma.paymentRequest.findFirst.mockResolvedValue(null);

      const result = await service.findPendingByReceivingAddress('unknown_address');
      expect(result).toBeNull();
    });
  });

  // ── matchInflow ───────────────────────────────────────────────────────────────

  describe('matchInflow', () => {
    const INFLOW = {
      id:                 INFLOW_ID,
      receiving_address:  'pay_hash_001',
      provider_reference: 'pay_hash_001',
      amount:             new Decimal('386598'),
    };

    it('updates PaymentRequest status to PAID with inflow_id in a transaction', async () => {
      await service.matchInflow({ payment_request: DB_PAYMENT_REQUEST as never, inflow: INFLOW as never });

      const tx_fn = prisma.$transaction.mock.calls[0][0];
      const tx = {
        paymentRequest: { update: jest.fn().mockResolvedValue({}) },
        inflow: { update: jest.fn().mockResolvedValue({}) },
      };
      await tx_fn(tx);

      expect(tx.paymentRequest.update).toHaveBeenCalledWith({
        where: { id: PR_ID },
        data: expect.objectContaining({
          status:    PaymentRequestStatus.PAID,
          inflow_id: INFLOW_ID,
          paid_at:   expect.any(Date),
        }),
      });
    });

    it('marks Inflow as matched with source denormalized in a transaction', async () => {
      await service.matchInflow({ payment_request: DB_PAYMENT_REQUEST as never, inflow: INFLOW as never });

      const tx_fn = prisma.$transaction.mock.calls[0][0];
      const tx = {
        paymentRequest: { update: jest.fn().mockResolvedValue({}) },
        inflow: { update: jest.fn().mockResolvedValue({}) },
      };
      await tx_fn(tx);

      expect(tx.inflow.update).toHaveBeenCalledWith({
        where: { id: INFLOW_ID },
        data: expect.objectContaining({
          is_matched:  true,
          matched_at:  expect.any(Date),
          source_type: 'LOAN',
          source_id:   LOAN_ID,
        }),
      });
    });

    it('deletes Redis cache key after transaction commits', async () => {
      await service.matchInflow({ payment_request: DB_PAYMENT_REQUEST as never, inflow: INFLOW as never });
      expect(redis.del).toHaveBeenCalledWith('payment_request:pending:pay_hash_001');
    });

    it('returns the updated PaymentRequest', async () => {
      const result = await service.matchInflow({ payment_request: DB_PAYMENT_REQUEST as never, inflow: INFLOW as never });
      expect(result).toBeDefined();
    });
  });

  // ── markExpired ───────────────────────────────────────────────────────────────

  describe('markExpired', () => {
    it('sets PaymentRequest status to EXPIRED', async () => {
      prisma.paymentRequest.update.mockResolvedValue({ ...DB_PAYMENT_REQUEST, status: PaymentRequestStatus.EXPIRED });

      await service.markExpired(PR_ID, 'pay_hash_001');

      expect(prisma.paymentRequest.update).toHaveBeenCalledWith({
        where: { id: PR_ID },
        data: { status: PaymentRequestStatus.EXPIRED },
      });
    });

    it('removes expired PaymentRequest from Redis cache', async () => {
      prisma.paymentRequest.update.mockResolvedValue({ ...DB_PAYMENT_REQUEST, status: PaymentRequestStatus.EXPIRED });

      await service.markExpired(PR_ID, 'pay_hash_001');

      expect(redis.del).toHaveBeenCalledWith('payment_request:pending:pay_hash_001');
    });
  });
});
