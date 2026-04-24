import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { KycController } from './kyc.controller';
import { KycService } from './kyc.service';
import { KYC_PROVIDER_T1, KYC_PROVIDER_T2, KYC_PROVIDER_T3, type KycProvider } from './kyc.provider.interface';
import { DatabaseModule } from '@/database/database.module';
import { CryptoModule } from '@/common/crypto/crypto.module';
import { NameMatchModule } from '@/common/name-match/name-match.module';
import { QoreidModule } from '@/providers/qoreid/qoreid.module';
import { QoreidProvider } from '@/providers/qoreid/qoreid.provider';
import { DojahModule } from '@/providers/dojah/dojah.module';
import { DojahProvider } from '@/providers/dojah/dojah.provider';
import { KYC_TIER_CONFIG, KycProviderName } from '@/config/kyc.config';
import { StubKycProvider } from '@/providers/stub/stub-kyc.provider';
import { UserRepaymentAccountsModule } from '@/modules/user-repayment-accounts/user-repayment-accounts.module';

const stub_kyc_provider = new StubKycProvider();

function resolveKycProvider(
  name: KycProviderName,
  qoreid: QoreidProvider,
  dojah: DojahProvider,
): KycProvider {
  switch (name) {
    case KycProviderName.Qoreid: return qoreid;
    case KycProviderName.Dojah:  return dojah;
    case KycProviderName.Stub:   return stub_kyc_provider;
  }
}

@Module({
  imports: [DatabaseModule, CryptoModule, ConfigModule, NameMatchModule, QoreidModule, DojahModule, UserRepaymentAccountsModule],
  controllers: [KycController],
  providers: [
    KycService,
    {
      provide: KYC_PROVIDER_T1,
      inject: [QoreidProvider, DojahProvider],
      useFactory: (qoreid: QoreidProvider, dojah: DojahProvider): KycProvider =>
        resolveKycProvider(KYC_TIER_CONFIG.tier1, qoreid, dojah),
    },
    {
      provide: KYC_PROVIDER_T2,
      inject: [QoreidProvider, DojahProvider],
      useFactory: (qoreid: QoreidProvider, dojah: DojahProvider): KycProvider =>
        resolveKycProvider(KYC_TIER_CONFIG.tier2, qoreid, dojah),
    },
    {
      provide: KYC_PROVIDER_T3,
      inject: [QoreidProvider, DojahProvider],
      useFactory: (qoreid: QoreidProvider, dojah: DojahProvider): KycProvider =>
        resolveKycProvider(KYC_TIER_CONFIG.tier3, qoreid, dojah),
    },
  ],
  exports: [KycService],
})
export class KycModule {}
