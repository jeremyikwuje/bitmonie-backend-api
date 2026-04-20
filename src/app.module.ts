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
import { KycModule } from './modules/kyc/kyc.module';

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
    KycModule,
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: IdempotencyInterceptor,
    },
  ],
})
export class AppModule {}
