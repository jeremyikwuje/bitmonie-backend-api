import { runExpiryCycle, type LoanExpiryDeps } from '../../../workers/loan-expiry.worker';
import { LoanStatus, PaymentRequestStatus, StatusTrigger } from '@prisma/client';
import { REDIS_KEYS, LoanReasonCodes } from '@/common/constants';

const LOAN_ID              = 'loan-uuid-001';
const USER_ID              = 'user-uuid-001';
const PAYMENT_REQUEST_ID   = 'pr-uuid-001';
const RECEIVING_ADDRESS    = 'lnbc1_test_address';

type MockTx = {
  loan:           { update: jest.Mock };
  loanStatusLog:  { create: jest.Mock };
  paymentRequest: { update: jest.Mock };
};

function makeExpiredRow(overrides: Partial<{
  loan_id: string;
  user_id: string;
  payment_request_id: string;
  receiving_address: string;
}> = {}) {
  return {
    loan_id:            LOAN_ID,
    user_id:            USER_ID,
    payment_request_id: PAYMENT_REQUEST_ID,
    receiving_address:  RECEIVING_ADDRESS,
    ...overrides,
  };
}

function makeMockTx(): MockTx {
  return {
    loan:           { update: jest.fn().mockResolvedValue({}) },
    loanStatusLog:  { create: jest.fn().mockResolvedValue({}) },
    paymentRequest: { update: jest.fn().mockResolvedValue({}) },
  };
}

function makeDeps(
  expired_rows: ReturnType<typeof makeExpiredRow>[] = [],
): LoanExpiryDeps & { prisma: jest.Mocked<LoanExpiryDeps['prisma']>; redis: jest.Mocked<LoanExpiryDeps['redis']>; log: jest.Mock } {
  const shared_tx = makeMockTx();

  const prisma = {
    $queryRaw:    jest.fn().mockResolvedValue(expired_rows),
    $transaction: jest.fn().mockImplementation((fn: (tx: MockTx) => Promise<unknown>) => fn(shared_tx)),
    _mock_tx:     shared_tx,
  } as unknown as jest.Mocked<LoanExpiryDeps['prisma']>;

  const redis = {
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  } as unknown as jest.Mocked<LoanExpiryDeps['redis']>;

  const log = jest.fn();

  return { prisma, redis, log } as unknown as LoanExpiryDeps & {
    prisma: jest.Mocked<LoanExpiryDeps['prisma']>;
    redis: jest.Mocked<LoanExpiryDeps['redis']>;
    log: jest.Mock;
  };
}

describe('runExpiryCycle', () => {
  it('does nothing when no loans are expired', async () => {
    const deps = makeDeps([]);

    await runExpiryCycle(deps);

    expect(deps.prisma.$transaction).not.toHaveBeenCalled();
    expect(deps.redis.del).not.toHaveBeenCalled();
    expect(deps.redis.set).toHaveBeenCalledWith(
      REDIS_KEYS.WORKER_HEARTBEAT('loan_expiry'),
      expect.any(String),
    );
  });

  it('transitions an expired loan to EXPIRED status within a transaction', async () => {
    const deps = makeDeps([makeExpiredRow()]);

    await runExpiryCycle(deps);

    expect(deps.prisma.$transaction).toHaveBeenCalledTimes(1);
    const tx = (deps.prisma as unknown as { _mock_tx: MockTx })._mock_tx;

    expect(tx.loan.update).toHaveBeenCalledWith({
      where: { id: LOAN_ID },
      data:  { status: LoanStatus.EXPIRED },
    });
  });

  it('writes a loan_status_log row in the same transaction', async () => {
    const deps = makeDeps([makeExpiredRow()]);

    await runExpiryCycle(deps);

    const tx = (deps.prisma as unknown as { _mock_tx: MockTx })._mock_tx;
    expect(tx.loanStatusLog.create).toHaveBeenCalledWith({
      data: {
        loan_id:      LOAN_ID,
        user_id:      USER_ID,
        from_status:  LoanStatus.PENDING_COLLATERAL,
        to_status:    LoanStatus.EXPIRED,
        triggered_by: StatusTrigger.SYSTEM,
        reason_code:  LoanReasonCodes.INVOICE_EXPIRED,
      },
    });
  });

  it('marks the payment_request as EXPIRED in the same transaction', async () => {
    const deps = makeDeps([makeExpiredRow()]);

    await runExpiryCycle(deps);

    const tx = (deps.prisma as unknown as { _mock_tx: MockTx })._mock_tx;
    expect(tx.paymentRequest.update).toHaveBeenCalledWith({
      where: { id: PAYMENT_REQUEST_ID },
      data:  { status: PaymentRequestStatus.EXPIRED },
    });
  });

  it('deletes the Redis cache key for the expired payment request', async () => {
    const deps = makeDeps([makeExpiredRow()]);

    await runExpiryCycle(deps);

    expect(deps.redis.del).toHaveBeenCalledWith(
      REDIS_KEYS.PAYMENT_REQUEST_PENDING(RECEIVING_ADDRESS),
    );
  });

  it('posts heartbeat to Redis after the cycle', async () => {
    const deps = makeDeps([makeExpiredRow()]);

    await runExpiryCycle(deps);

    expect(deps.redis.set).toHaveBeenCalledWith(
      REDIS_KEYS.WORKER_HEARTBEAT('loan_expiry'),
      expect.any(String),
    );
  });

  it('continues expiring remaining loans if one fails', async () => {
    const row1 = makeExpiredRow({ loan_id: 'loan-001', payment_request_id: 'pr-001' });
    const row2 = makeExpiredRow({ loan_id: 'loan-002', payment_request_id: 'pr-002' });
    const deps = makeDeps([row1, row2]);

    let call_count = 0;
    (deps.prisma.$transaction as jest.Mock).mockImplementation((fn: (tx: MockTx) => Promise<unknown>) => {
      call_count++;
      if (call_count === 1) throw new Error('DB error on first loan');
      return fn(makeMockTx());
    });

    await runExpiryCycle(deps);

    expect(deps.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(deps.log).toHaveBeenCalledWith('error', 'expiry_failed', expect.objectContaining({ loan_id: 'loan-001' }));
    expect(deps.log).toHaveBeenCalledWith('info', 'loan_expired', expect.objectContaining({ loan_id: 'loan-002' }));
  });
});
