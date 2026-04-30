import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaService } from '@/database/prisma.service';
import { RedisModule } from '@/database/redis.module';
import { PriceFeedModule } from '@/modules/price-feed/price-feed.module';
import { PaymentRequestsModule } from '@/modules/payment-requests/payment-requests.module';
import { UserRepaymentAccountsModule } from '@/modules/user-repayment-accounts/user-repayment-accounts.module';
import { LoanNotificationsModule } from '@/modules/loan-notifications/loan-notifications.module';
import { BlinkModule } from '@/providers/blink/blink.module';
import { BlinkProvider } from '@/providers/blink/blink.provider';
import type { ProvidersConfig } from '@/config/providers.config';
import { COLLATERAL_PROVIDER } from '@/modules/payment-requests/collateral.provider.interface';
import { LoansController } from './loans.controller';
import { LoansService } from './loans.service';
import { CalculatorService } from './calculator.service';
import { AccrualService } from './accrual.service';
import { LoanStatusService } from './loan-status.service';
import { PRICE_QUOTE_PROVIDER } from './price-quote.provider.interface';

// Both factories pick the active collateral provider per config. They resolve to
// the same Blink singleton (provided by BlinkModule), so the loans module reuses
// the shared connection / API key.
function pickCollateralProvider(config: ConfigService, blink: BlinkProvider) {
  const provider_name = config.get<ProvidersConfig>('providers')!.active.collateral;
  switch (provider_name) {
    case 'blink':
      return blink;
    default:
      throw new Error(`No CollateralProvider available for '${provider_name}'`);
  }
}

@Module({
  imports: [
    PriceFeedModule,
    PaymentRequestsModule,
    UserRepaymentAccountsModule,
    LoanNotificationsModule,
    BlinkModule,
    ConfigModule,
    RedisModule,
  ],
  controllers: [LoansController],
  providers: [
    PrismaService,
    LoansService,
    CalculatorService,
    AccrualService,
    LoanStatusService,
    {
      provide: PRICE_QUOTE_PROVIDER,
      inject: [ConfigService, BlinkProvider],
      useFactory: pickCollateralProvider,
    },
    {
      provide: COLLATERAL_PROVIDER,
      inject: [ConfigService, BlinkProvider],
      useFactory: pickCollateralProvider,
    },
  ],
  exports: [LoansService, LoanStatusService, AccrualService],
})
export class LoansModule {}
