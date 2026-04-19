import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PostmarkProvider } from './postmark.provider';
import type { ProvidersConfig } from '@/config/providers.config';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: PostmarkProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService): PostmarkProvider => {
        const pc = config.get<ProvidersConfig>('providers')!;
        return new PostmarkProvider(pc.postmark);
      },
    },
  ],
  exports: [PostmarkProvider],
})
export class PostmarkModule {}
