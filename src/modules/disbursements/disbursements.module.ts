import { Module } from '@nestjs/common';
import { PalmpayModule } from '@/providers/palmpay/palmpay.module';
import { PalmpayProvider } from '@/providers/palmpay/palmpay.provider';
import { StubDisbursementProvider } from '@/providers/stub/stub-disbursement.provider';
import { DisbursementProviderName } from '@/config/disbursement.config';
import { PrismaService } from '@/database/prisma.service';
import type { DisbursementProvider } from './disbursement.provider.interface';
import { DisbursementRouter, DISBURSEMENT_PROVIDERS_MAP } from './disbursement-router.service';
import { DisbursementsService } from './disbursements.service';
import { OutflowsService } from './outflows.service';

const stub_disbursement_provider = new StubDisbursementProvider();

function resolveDisbursementProvider(
  name: DisbursementProviderName,
  palmpay: PalmpayProvider,
): DisbursementProvider {
  switch (name) {
    case DisbursementProviderName.Palmpay: return palmpay;
    case DisbursementProviderName.Stub:    return stub_disbursement_provider;
  }
}

// Register all concrete providers here when onboarding a new partner.
const ALL_PROVIDER_MODULES = [PalmpayModule];

@Module({
  imports: [...ALL_PROVIDER_MODULES],
  providers: [
    PrismaService,
    {
      provide: DISBURSEMENT_PROVIDERS_MAP,
      inject: [PalmpayProvider],
      useFactory: (palmpay: PalmpayProvider): Map<string, DisbursementProvider> =>
        new Map(
          Object.values(DisbursementProviderName).map((name) => [
            name,
            resolveDisbursementProvider(name, palmpay),
          ]),
        ),
    },
    DisbursementRouter,
    DisbursementsService,
    OutflowsService,
  ],
  exports: [DisbursementRouter, DisbursementsService, OutflowsService],
})
export class DisbursementsModule {}
