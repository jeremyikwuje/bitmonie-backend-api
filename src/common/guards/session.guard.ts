import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { createHash } from 'crypto';
import { PrismaService } from '@/database/prisma.service';

function extractToken(request: Request): string | null {
  const cookies = (request as Request & { cookies?: Record<string, string> }).cookies ?? {};
  if (cookies.session) return cookies.session;

  const auth_header = request.headers.authorization;
  if (auth_header?.startsWith('Bearer ')) return auth_header.slice(7);

  return null;
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = extractToken(request);

    if (!token) throw new UnauthorizedException();

    const token_hash = createHash('sha256').update(token).digest('hex');
    const session = await this.prisma.session.findUnique({ where: { token_hash } });

    if (!session || session.expires_at < new Date()) throw new UnauthorizedException();

    const user = await this.prisma.user.findUnique({
      where: { id: session.user_id },
    });

    if (!user) throw new UnauthorizedException();

    (request as Request & { user?: unknown }).user = user;
    return true;
  }
}
