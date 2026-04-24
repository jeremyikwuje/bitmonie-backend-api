/**
 * Loan Expiry Worker — standalone Node.js process (NOT NestJS).
 * Marks PENDING_COLLATERAL loans as EXPIRED when their payment-request window has passed.
 * Run with: ts-node -r tsconfig-paths/register workers/loan-expiry.worker.ts
 */

import { PrismaClient, LoanStatus, PaymentRequestStatus, StatusTrigger } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import Redis from 'ioredis';
import { REDIS_KEYS, LoanReasonCodes } from '@/common/constants';

const WORKER_INTERVAL_MS = parseInt(process.env.WORKER_LOAN_EXPIRY_INTERVAL_MS ?? '60000', 10);

export interface LoanExpiryDeps {
  prisma: PrismaClient;
  redis: Redis;
  log: (level: string, event: string, extra?: Record<string, unknown>) => void;
}

function defaultLog(level: string, event: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(
    JSON.stringify({ level, worker: 'loan_expiry', event, time: new Date().toISOString(), ...extra }) + '\n',
  );
}

type ExpiredLoanRow = {
  loan_id: string;
  user_id: string;
  payment_request_id: string;
  receiving_address: string;
};

export async function runExpiryCycle(deps: LoanExpiryDeps): Promise<void> {
  const { prisma, redis, log } = deps;

  // Query PENDING_COLLATERAL loans whose payment_request has expired
  const expired_loans = await prisma.$queryRaw<ExpiredLoanRow[]>`
    SELECT
      l.id          AS loan_id,
      l.user_id     AS user_id,
      pr.id         AS payment_request_id,
      pr.receiving_address AS receiving_address
    FROM loans l
    JOIN payment_requests pr
      ON pr.source_type = 'LOAN'
     AND pr.source_id   = l.id
     AND pr.status      = ${PaymentRequestStatus.PENDING}::"payment_request_status"
    WHERE l.status    = ${LoanStatus.PENDING_COLLATERAL}::"LoanStatus"
      AND pr.expires_at < NOW()
    FOR UPDATE SKIP LOCKED
  `;

  let expired = 0;

  for (const row of expired_loans) {
    try {
      await expireLoan(prisma, redis, row, log);
      expired++;
    } catch (err) {
      log('error', 'expiry_failed', {
        loan_id: row.loan_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await redis.set(REDIS_KEYS.WORKER_HEARTBEAT('loan_expiry'), Date.now().toString());

  if (expired > 0) {
    log('info', 'cycle_complete', { expired });
  }
}

async function expireLoan(
  prisma: PrismaClient,
  redis: Redis,
  row: ExpiredLoanRow,
  log: LoanExpiryDeps['log'],
): Promise<void> {
  await (prisma as PrismaClient).$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.loan.update({
      where: { id: row.loan_id },
      data:  { status: LoanStatus.EXPIRED },
    });

    await tx.loanStatusLog.create({
      data: {
        loan_id:      row.loan_id,
        user_id:      row.user_id,
        from_status:  LoanStatus.PENDING_COLLATERAL,
        to_status:    LoanStatus.EXPIRED,
        triggered_by: StatusTrigger.SYSTEM,
        reason_code:  LoanReasonCodes.INVOICE_EXPIRED,
      },
    });

    await tx.paymentRequest.update({
      where: { id: row.payment_request_id },
      data:  { status: PaymentRequestStatus.EXPIRED },
    });
  });

  // Remove Redis cache key for the expired payment request
  await redis.del(REDIS_KEYS.PAYMENT_REQUEST_PENDING(row.receiving_address));

  log('info', 'loan_expired', {
    loan_id: row.loan_id,
    user_id: row.user_id,
    payment_request_id: row.payment_request_id,
  });
}

async function main(): Promise<void> {
  const DATABASE_URL = process.env.DATABASE_URL;
  const REDIS_URL    = process.env.REDIS_URL;
  if (!DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
  if (!REDIS_URL)    { console.error('REDIS_URL is required');    process.exit(1); }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });
  const redis = new Redis(REDIS_URL);
  redis.on('error', (err) => defaultLog('error', 'redis_error', { error: err.message }));

  const deps: LoanExpiryDeps = { prisma, redis, log: defaultLog };

  defaultLog('info', 'started', { interval_ms: WORKER_INTERVAL_MS });
  await redis.ping();
  await runExpiryCycle(deps);

  setInterval(() => {
    runExpiryCycle(deps).catch((err) =>
      defaultLog('error', 'unhandled_error', { error: String(err) }),
    );
  }, WORKER_INTERVAL_MS);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Worker failed to start:', err);
    process.exit(1);
  });
}
