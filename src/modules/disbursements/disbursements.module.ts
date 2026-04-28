import { Module } from '@nestjs/common';
import { PalmpayModule } from '@/providers/palmpay/palmpay.module';
import { PalmpayProvider } from '@/providers/palmpay/palmpay.provider';
import { StubDisbursementProvider } from '@/providers/stub/stub-disbursement.provider';
import { DisbursementProviderName } from '@/config/disbursement.config';
import { PrismaService } from '@/database/prisma.service';
import { OpsAlertsModule } from '@/modules/ops-alerts/ops-alerts.module';
import type { DisbursementProvider } from './disbursement.provider.interface';
import { DisbursementRouter, DISBURSEMENT_PROVIDERS_MAP } from './disbursement-router.service';
import { DisbursementsService } from './disbursements.service';
import { OutflowsService } from './outflows.service';

function resolveDisbursementProvider(
  name: DisbursementProviderName,
  palmpay: PalmpayProvider,
  stub: StubDisbursementProvider,
): DisbursementProvider {
  switch (name) {
    case DisbursementProviderName.Palmpay: return palmpay;
    case DisbursementProviderName.Stub:    return stub;
  }
}

// Register all concrete providers here when onboarding a new partner.
const ALL_PROVIDER_MODULES = [PalmpayModule];

@Module({
  imports: [...ALL_PROVIDER_MODULES, OpsAlertsModule],
  providers: [
    PrismaService,
    StubDisbursementProvider,
    {
      provide: DISBURSEMENT_PROVIDERS_MAP,
      inject: [PalmpayProvider, StubDisbursementProvider],
      useFactory: (palmpay: PalmpayProvider, stub: StubDisbursementProvider): Map<string, DisbursementProvider> =>
        new Map(
          Object.values(DisbursementProviderName).map((name) => [
            name,
            resolveDisbursementProvider(name, palmpay, stub),
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
