import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BlinkModule } from '@/providers/blink/blink.module';
import { BlinkProvider } from '@/providers/blink/blink.provider';
import { StubCollateralProvider } from '@/providers/stub/stub-collateral.provider';
import { PrismaService } from '@/database/prisma.service';
import type { ProvidersConfig } from '@/config/providers.config';
import { COLLATERAL_PROVIDER } from './collateral.provider.interface';
import { PaymentRequestsService } from './payment-requests.service';

@Module({
  imports: [BlinkModule],
  providers: [
    PrismaService,
    {
      provide: COLLATERAL_PROVIDER,
      inject: [ConfigService, BlinkProvider],
      useFactory: (config: ConfigService, blink: BlinkProvider) => {
        const active = config.get<ProvidersConfig>('providers')?.active?.collateral ?? 'blink';
        switch (active) {
          case 'blink': return blink;
          case 'stub':  return new StubCollateralProvider();
          default:      throw new Error(`Unknown collateral provider: ${active}`);
        }
      },
    },
    PaymentRequestsService,
  ],
  exports: [PaymentRequestsService],
})
export class PaymentRequestsModule {}
