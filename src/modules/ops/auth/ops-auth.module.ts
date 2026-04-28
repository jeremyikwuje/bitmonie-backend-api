import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '@/database/database.module';
import { CryptoModule } from '@/common/crypto/crypto.module';
import { RedisModule } from '@/database/redis.module';
import { OpsGuard } from '@/common/guards/ops-session.guard';
import { OpsAuthController } from './ops-auth.controller';
import { OpsAuthService } from './ops-auth.service';
import { OpsSessionService } from './ops-session.service';
import { OpsAuditService } from './ops-audit.service';

@Module({
  imports: [DatabaseModule, CryptoModule, ConfigModule, RedisModule],
  controllers: [OpsAuthController],
  providers: [
    OpsAuthService,
    OpsSessionService,
    OpsAuditService,
    OpsGuard,
  ],
  exports: [
    OpsAuthService,
    OpsSessionService,
    OpsAuditService,
    OpsGuard,
  ],
})
export class OpsAuthModule {}
