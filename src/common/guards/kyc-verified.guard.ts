import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { KycStatus, type Kyc, type User } from '@prisma/client';
import { LoanKycRequiredException } from '@/common/errors/bitmonie.errors';

type AuthenticatedUser = User & { kyc: Kyc | null };

@Injectable()
export class KycVerifiedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<
      Request & { user?: AuthenticatedUser }
    >();
    const user = request.user;
    if (!user || !user.kyc || user.kyc.status !== KycStatus.VERIFIED) {
      throw new LoanKycRequiredException();
    }
    return true;
  }
}
