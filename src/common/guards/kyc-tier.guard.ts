import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { User } from '@prisma/client';
import { KycUpgradeRequiredException } from '@/common/errors/bitmonie.errors';
import { REQUIRES_KYC_KEY } from '@/common/decorators/requires-kyc.decorator';

@Injectable()
export class KycTierGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required_tier = this.reflector.getAllAndOverride<number | undefined>(
      REQUIRES_KYC_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (required_tier === undefined) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: User }>();
    const user = request.user;

    if (!user || user.kyc_tier < required_tier) {
      throw new KycUpgradeRequiredException(required_tier);
    }

    return true;
  }
}
