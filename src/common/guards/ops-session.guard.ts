import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { createHash } from 'crypto';
import { PrismaService } from '@/database/prisma.service';
import {
  OpsSessionInvalidException,
  OpsUserDisabledException,
} from '@/common/errors/bitmonie.errors';

// Cookie isolation is the load-bearing property of this file. SessionGuard
// reads `cookies.session`; OpsGuard reads `cookies.ops_session`. They are
// distinct names AND distinct DB tables — a customer cookie hitting an ops
// route lands here with no `ops_session` cookie present and is rejected
// before any DB lookup.
function extractToken(request: Request): string | null {
  const cookies = (request as Request & { cookies?: Record<string, string> }).cookies ?? {};
  if (cookies.ops_session) return cookies.ops_session;

  const auth_header = request.headers.authorization;
  if (auth_header?.startsWith('Bearer ')) return auth_header.slice(7);

  return null;
}

@Injectable()
export class OpsGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = extractToken(request);

    if (!token) throw new OpsSessionInvalidException();

    const token_hash = createHash('sha256').update(token).digest('hex');
    const session = await this.prisma.opsSession.findUnique({ where: { token_hash } });

    if (!session || session.expires_at < new Date()) {
      throw new OpsSessionInvalidException();
    }

    const ops_user = await this.prisma.opsUser.findUnique({
      where: { id: session.ops_user_id },
    });

    if (!ops_user) throw new OpsSessionInvalidException();
    if (!ops_user.is_active) throw new OpsUserDisabledException();

    (request as Request & { ops_user?: unknown }).ops_user = ops_user;
    return true;
  }
}
