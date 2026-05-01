import { LoanStatus } from '@prisma/client';
import { mock, MockProxy } from 'jest-mock-extended';
import { CollateralReleaseService } from '@/modules/loans/collateral-release.service';
import { LoanStatusService } from '@/modules/loans/loan-status.service';
import { OpsAlertsService } from '@/modules/ops-alerts/ops-alerts.service';
import { LoanNotificationsService } from '@/modules/loan-notifications/loan-notifications.service';
import type { CollateralProvider } from '@/modules/payment-requests/collateral.provider.interface';
import type { PrismaService } from '@/database/prisma.service';

const LOAN_ID  = 'loan-uuid-001';
const USER_ID  = 'user-uuid-001';
const ADDRESS  = 'ada@blink.sv';
const REF      = 'blink:ln_address:ada@blink.sv:42:0';

function makeLoan(overrides: Record<string, unknown> = {}) {
  return {
    id:                          LOAN_ID,
    user_id:                     USER_ID,
    status:                      LoanStatus.REPAID,
    collateral_amount_sat:       BigInt(515464),
    collateral_release_address:  ADDRESS,
    collateral_released_at:      null,
    collateral_release_reference: null,
    ...overrides,
  };
}

function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    loan: {
      findUnique: jest.fn().mockResolvedValue(makeLoan()),
    },
    $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        loan: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        loanStatusLog: { create: jest.fn().mockResolvedValue({}) },
      }),
    ),
    ...overrides,
  } as unknown as PrismaService;
}

function makeRedis() {
  return {
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  } as unknown as import('ioredis').default;
}

describe('CollateralReleaseService', () => {
  let provider:           MockProxy<CollateralProvider>;
  let ops_alerts:         MockProxy<OpsAlertsService>;
  let loan_status:        MockProxy<LoanStatusService>;
  let loan_notifications: MockProxy<LoanNotificationsService>;

  beforeEach(() => {
    provider           = mock<CollateralProvider>();
    ops_alerts         = mock<OpsAlertsService>();
    loan_status        = mock<LoanStatusService>();
    loan_notifications = mock<LoanNotificationsService>();
    provider.sendToLightningAddress.mockResolvedValue(REF);
  });

  function makeService(deps: { prisma?: PrismaService; redis?: import('ioredis').default } = {}) {
    return new CollateralReleaseService(
      deps.prisma ?? makePrisma(),
      provider,
      loan_status,
      ops_alerts,
      deps.redis ?? makeRedis(),
      loan_notifications,
    );
  }

  // ── happy path ─────────────────────────────────────────────────────────────

  it('sends SAT and stamps the release on REPAID + address-set + not-yet-released', async () => {
    const prisma = makePrisma();
    const service = makeService({ prisma });

    const result = await service.releaseForLoan(LOAN_ID);

    expect(result).toEqual({ status: 'released', reference: REF });
    expect(provider.sendToLightningAddress).toHaveBeenCalledWith({
      address:    ADDRESS,
      amount_sat: BigInt(515464),
      memo:       expect.stringContaining(LOAN_ID),
    });
  });

  it('writes a status_log via LoanStatusService for the REPAID→REPAID self-transition', async () => {
    const service = makeService();
    await service.releaseForLoan(LOAN_ID);
    expect(loan_status.transition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        from_status:  LoanStatus.REPAID,
        to_status:    LoanStatus.REPAID,
        reason_code:  'COLLATERAL_RELEASED',
      }),
    );
  });

  // ── ineligibility ──────────────────────────────────────────────────────────

  it('returns not_eligible when the loan is not REPAID', async () => {
    const prisma = makePrisma();
    (prisma.loan.findUnique as jest.Mock).mockResolvedValue(makeLoan({ status: LoanStatus.ACTIVE }));
    const service = makeService({ prisma });

    const result = await service.releaseForLoan(LOAN_ID);
    expect(result.status).toBe('not_eligible');
    expect(provider.sendToLightningAddress).not.toHaveBeenCalled();
  });

  it('returns already_released when collateral_released_at is already set', async () => {
    const prisma = makePrisma();
    (prisma.loan.findUnique as jest.Mock).mockResolvedValue(makeLoan({
      collateral_released_at:       new Date('2026-01-01T00:00:00Z'),
      collateral_release_reference: 'previous-ref',
    }));
    const service = makeService({ prisma });

    const result = await service.releaseForLoan(LOAN_ID);
    expect(result).toEqual({ status: 'already_released', reference: 'previous-ref' });
    expect(provider.sendToLightningAddress).not.toHaveBeenCalled();
  });

  it('returns not_eligible when collateral_release_address is null', async () => {
    const prisma = makePrisma();
    (prisma.loan.findUnique as jest.Mock).mockResolvedValue(makeLoan({ collateral_release_address: null }));
    const service = makeService({ prisma });

    const result = await service.releaseForLoan(LOAN_ID);
    expect(result.status).toBe('not_eligible');
    if (result.status === 'not_eligible') {
      expect(result.reason).toBe('no_release_address');
    }
    expect(provider.sendToLightningAddress).not.toHaveBeenCalled();
  });

  it('returns not_eligible when the loan does not exist', async () => {
    const prisma = makePrisma();
    (prisma.loan.findUnique as jest.Mock).mockResolvedValue(null);
    const service = makeService({ prisma });

    const result = await service.releaseForLoan(LOAN_ID);
    expect(result.status).toBe('not_eligible');
  });

  // ── lock ──────────────────────────────────────────────────────────────────

  it('returns in_flight when another caller holds the Redis lock', async () => {
    const redis = makeRedis();
    (redis.set as jest.Mock).mockResolvedValue(null);  // SETNX failed → lock held

    const service = makeService({ redis });

    const result = await service.releaseForLoan(LOAN_ID);
    expect(result.status).toBe('in_flight');
    expect(provider.sendToLightningAddress).not.toHaveBeenCalled();
  });

  it('releases the Redis lock after success', async () => {
    const redis = makeRedis();
    const service = makeService({ redis });

    await service.releaseForLoan(LOAN_ID);
    expect(redis.del).toHaveBeenCalledWith(expect.stringContaining(`collateral_release:lock:${LOAN_ID}`));
  });

  it('releases the Redis lock after a send failure', async () => {
    const redis = makeRedis();
    provider.sendToLightningAddress.mockRejectedValue(new Error('Blink down'));
    const service = makeService({ redis });

    await service.releaseForLoan(LOAN_ID);
    expect(redis.del).toHaveBeenCalledWith(expect.stringContaining(`collateral_release:lock:${LOAN_ID}`));
  });

  // ── send failure → ops alert (rate-limited) ────────────────────────────────

  it('returns send_failed and pages ops once when provider rejects the send', async () => {
    const redis = makeRedis();
    // First SETNX (lock) → OK, second SETNX (alert dedupe) → OK so we DO alert.
    (redis.set as jest.Mock)
      .mockResolvedValueOnce('OK')   // lock
      .mockResolvedValueOnce('OK');  // alert dedupe — first alert wins
    provider.sendToLightningAddress.mockRejectedValue(new Error('Insufficient route'));
    const service = makeService({ redis });

    const result = await service.releaseForLoan(LOAN_ID);

    expect(result.status).toBe('send_failed');
    expect(ops_alerts.alertCollateralReleaseFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        loan_id:        LOAN_ID,
        alert_severity: 'standard',
        failure_reason: 'Insufficient route',
      }),
    );
  });

  it('does NOT page ops on send failure when alert dedupe key already exists', async () => {
    const redis = makeRedis();
    (redis.set as jest.Mock)
      .mockResolvedValueOnce('OK')    // lock acquired
      .mockResolvedValueOnce(null);   // alert dedupe already set → skip alert
    provider.sendToLightningAddress.mockRejectedValue(new Error('Insufficient route'));
    const service = makeService({ redis });

    const result = await service.releaseForLoan(LOAN_ID);

    expect(result.status).toBe('send_failed');
    expect(ops_alerts.alertCollateralReleaseFailed).not.toHaveBeenCalled();
  });

  // ── critical: send succeeded but DB stamp failed ───────────────────────────

  it('alerts CRITICAL when provider sent but DB stamp fails (no dedupe)', async () => {
    const prisma = makePrisma();
    (prisma.$transaction as jest.Mock).mockRejectedValue(new Error('connection lost'));
    const service = makeService({ prisma });

    const result = await service.releaseForLoan(LOAN_ID);

    expect(result.status).toBe('send_failed');
    expect(ops_alerts.alertCollateralReleaseFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        loan_id:            LOAN_ID,
        alert_severity:    'critical',
        provider_reference: REF,
        failure_reason:    expect.stringContaining('SEND_OK_STAMP_FAILED'),
      }),
    );
  });
});
