import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import type { Kyc, User } from '@prisma/client';

export type AuthenticatedUser = User & { kyc: Kyc | null };

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    if (!request.user) {
      throw new Error('CurrentUser decorator used on a route without SessionGuard');
    }
    return request.user;
  },
);
