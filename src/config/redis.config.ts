import { registerAs } from '@nestjs/config';

export interface RedisConfig {
  url: string;
}

export default registerAs('redis', (): RedisConfig => {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('REDIS_URL is required');
  }
  return { url };
});
