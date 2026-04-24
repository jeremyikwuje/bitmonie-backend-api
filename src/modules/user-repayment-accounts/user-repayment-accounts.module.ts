import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaService } from '@/database/prisma.service';
import { CryptoModule } from '@/common/crypto/crypto.module';
import { PalmpayModule } from '@/providers/palmpay/palmpay.module';
import { PalmpayProvider } from '@/providers/palmpay/palmpay.provider';
import type { ProvidersConfig } from '@/config/providers.config';
import { CollectionProviderName } from '@/config/disbursement.config';
import { UserRepaymentAccountsService } from './user-repayment-accounts.service';

@Module({
  imports: [ConfigModule, CryptoModule, PalmpayModule],
  providers: [
    PrismaService,
    UserRepaymentAccountsService,
    {
      provide: 'COLLECTION_PROVIDER',
      inject: [ConfigService, PalmpayProvider],
      useFactory: (config: ConfigService, palmpay: PalmpayProvider) => {
        const active = config.get<ProvidersConfig>('providers')!.active;
        switch (active.collection) {
          case CollectionProviderName.Palmpay: return palmpay;
          default: throw new Error(`Unknown collection provider: ${active.collection}`);
        }
      },
    },
  ],
  exports: [UserRepaymentAccountsService],
})
export class UserRepaymentAccountsModule {}
