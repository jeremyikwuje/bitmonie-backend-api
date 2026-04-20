import { SetMetadata } from '@nestjs/common';

export const REQUIRES_KYC_KEY = 'requires_kyc_tier';

export const RequiresKyc = (tier: number) => SetMetadata(REQUIRES_KYC_KEY, tier);
