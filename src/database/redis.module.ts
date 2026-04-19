import { Global, Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis => {
        const logger = new Logger('RedisClient');
        const url = config.get<string>('REDIS_URL');
        if (!url) {
          throw new Error('REDIS_URL is required');
        }
        const client = new Redis(url, {
          lazyConnect: false,
          maxRetriesPerRequest: 3,
        });
        client.on('error', (err) => logger.error(`Redis error: ${err.message}`));
        client.on('connect', () => logger.log('Redis connected'));
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
