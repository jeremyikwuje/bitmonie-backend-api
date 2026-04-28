import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { createHash } from 'crypto';
import { OpsGuard } from '@/common/guards/ops-session.guard';
import { SessionGuard } from '@/common/guards/session.guard';
import { PrismaService } from '@/database/prisma.service';

function make_prisma() {
  return {
    opsSession: { findUnique: jest.fn() },
    opsUser:    { findUnique: jest.fn() },
    session:    { findUnique: jest.fn() },
    user:       { findUnique: jest.fn() },
  };
}

function ctx_with(request: Partial<Request>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request as Request }),
  } as unknown as ExecutionContext;
}

function future(): Date { return new Date(Date.now() + 60_000); }
function past():   Date { return new Date(Date.now() - 60_000); }

describe('OpsGuard', () => {
  let prisma: ReturnType<typeof make_prisma>;
  let guard: OpsGuard;

  beforeEach(() => {
    prisma = make_prisma();
    guard = new OpsGuard(prisma as unknown as PrismaService);
  });

  it('throws OPS_SESSION_INVALID when no cookie and no Authorization header', async () => {
    const ctx = ctx_with({ cookies: {}, headers: {} });
    await expect(guard.canActivate(ctx))
      .rejects.toMatchObject({ code: 'OPS_SESSION_INVALID' });
  });

  it('throws OPS_SESSION_INVALID when ops_session cookie has no matching DB row', async () => {
    prisma.opsSession.findUnique.mockResolvedValue(null);

    const ctx = ctx_with({ cookies: { ops_session: 'fake' }, headers: {} });
    await expect(guard.canActivate(ctx))
      .rejects.toMatchObject({ code: 'OPS_SESSION_INVALID' });
  });

  it('throws OPS_SESSION_INVALID when ops_session row is expired', async () => {
    prisma.opsSession.findUnique.mockResolvedValue({
      ops_user_id: 'ops-uuid',
      expires_at: past(),
    });

    const ctx = ctx_with({ cookies: { ops_session: 'tok' }, headers: {} });
    await expect(guard.canActivate(ctx))
      .rejects.toMatchObject({ code: 'OPS_SESSION_INVALID' });
  });

  it('throws OPS_USER_DISABLED when ops_user.is_active=false', async () => {
    prisma.opsSession.findUnique.mockResolvedValue({ ops_user_id: 'ops-uuid', expires_at: future() });
    prisma.opsUser.findUnique.mockResolvedValue({ id: 'ops-uuid', is_active: false });

    const ctx = ctx_with({ cookies: { ops_session: 'tok' }, headers: {} });
    await expect(guard.canActivate(ctx))
      .rejects.toMatchObject({ code: 'OPS_USER_DISABLED' });
  });

  it('attaches ops_user to request on valid session', async () => {
    const ops_user = { id: 'ops-uuid', email: 'ops@example.com', is_active: true };
    prisma.opsSession.findUnique.mockResolvedValue({ ops_user_id: 'ops-uuid', expires_at: future() });
    prisma.opsUser.findUnique.mockResolvedValue(ops_user);

    const request: Partial<Request> & { ops_user?: unknown } = { cookies: { ops_session: 'tok' }, headers: {} };
    const ctx = ctx_with(request);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.ops_user).toBe(ops_user);

    const expected_hash = createHash('sha256').update('tok').digest('hex');
    expect(prisma.opsSession.findUnique).toHaveBeenCalledWith({ where: { token_hash: expected_hash } });
  });

  // ── Cross-cookie isolation (load-bearing) ────────────────────────────────────
  //
  // A request carrying ONLY the customer `session` cookie must not authenticate
  // an ops route, even if the customer's session token happens to collide with
  // an ops session's hash by accident — the guard reads the wrong cookie name
  // entirely, so the lookup never happens.
  it('does NOT authenticate when only customer `session` cookie is present', async () => {
    const ctx = ctx_with({ cookies: { session: 'customer-token' }, headers: {} });

    await expect(guard.canActivate(ctx))
      .rejects.toMatchObject({ code: 'OPS_SESSION_INVALID' });

    expect(prisma.opsSession.findUnique).not.toHaveBeenCalled();
    expect(prisma.session.findUnique).not.toHaveBeenCalled();
  });
});

describe('SessionGuard cross-cookie isolation', () => {
  let prisma: ReturnType<typeof make_prisma>;
  let guard: SessionGuard;

  beforeEach(() => {
    prisma = make_prisma();
    guard = new SessionGuard(prisma as unknown as PrismaService);
  });

  // The mirror property: a request bearing ONLY the `ops_session` cookie must
  // not authenticate a customer route. Together with the OpsGuard test above,
  // this seals the cross-domain leak: ops cookies stay ops-side, customer
  // cookies stay customer-side.
  it('does NOT authenticate when only `ops_session` cookie is present', async () => {
    const ctx = ctx_with({ cookies: { ops_session: 'ops-token' }, headers: {} });

    await expect(guard.canActivate(ctx)).rejects.toThrow(); // UnauthorizedException

    expect(prisma.session.findUnique).not.toHaveBeenCalled();
    expect(prisma.opsSession.findUnique).not.toHaveBeenCalled();
  });
});
