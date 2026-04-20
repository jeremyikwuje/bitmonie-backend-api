import { Injectable, Inject } from '@nestjs/common';
import { DisbursementRail } from '@prisma/client';
import { DISBURSEMENT_ROUTES_CONFIG, type DisbursementRoutesConfig } from '@/config/disbursement.config';
import type { DisbursementProvider } from './disbursement.provider.interface';

export const DISBURSEMENT_PROVIDERS_MAP = 'DISBURSEMENT_PROVIDERS_MAP';

@Injectable()
export class DisbursementRouter {
  private readonly routes: DisbursementRoutesConfig = DISBURSEMENT_ROUTES_CONFIG;

  constructor(
    @Inject(DISBURSEMENT_PROVIDERS_MAP)
    private readonly providers_map: Map<string, DisbursementProvider>,
  ) {}

  forRoute(currency: string, rail: DisbursementRail): DisbursementProvider {
    const currency_routes = this.routes[currency as keyof DisbursementRoutesConfig];
    const route_config = currency_routes?.[rail];

    if (!route_config) {
      throw new Error(`No disbursement route configured for ${currency}:${rail}`);
    }

    const provider = this.providers_map.get(route_config.provider);
    if (!provider) {
      throw new Error(`Disbursement provider '${route_config.provider}' is not registered (route: ${currency}:${rail})`);
    }

    return provider;
  }
}
