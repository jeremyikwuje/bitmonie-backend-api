import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import appConfig from '@/config/app.config';
import databaseConfig from '@/config/database.config';
import redisConfig from '@/config/redis.config';
import providersConfig from '@/config/providers.config';
import { DatabaseModule } from '@/database/database.module';
import { RedisModule } from '@/database/redis.module';
import { CryptoModule } from '@/common/crypto/crypto.module';
import { IdempotencyInterceptor } from '@/common/interceptors/idempotency.interceptor';
import { PriceFeedModule } from './modules/price-feed/price-feed.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { KycModule } from './modules/kyc/kyc.module';
import { DisbursementAccountsModule } from './modules/disbursement-accounts/disbursement-accounts.module';
import { LoansModule } from './modules/loans/loans.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, redisConfig, providersConfig],
    }),
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: 60 },
    ]),
    DatabaseModule,
    RedisModule,
    CryptoModule,
    PriceFeedModule,
    AuthModule,
    UsersModule,
    KycModule,
    DisbursementAccountsModule,
    LoansModule,
    WebhooksModule,
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: IdempotencyInterceptor,
    },
  ],
})
export class AppModule {}
