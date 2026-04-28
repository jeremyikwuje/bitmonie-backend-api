import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import type { OpsUser } from '@prisma/client';

export type AuthenticatedOpsUser = OpsUser;

export const CurrentOpsUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedOpsUser => {
    const request = ctx.switchToHttp().getRequest<Request & { ops_user?: AuthenticatedOpsUser }>();
    if (!request.ops_user) {
      throw new Error('CurrentOpsUser decorator used on a route without OpsGuard');
    }
    return request.ops_user;
  },
);
