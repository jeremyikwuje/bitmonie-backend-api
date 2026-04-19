import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { mockDeep } from 'jest-mock-extended';
import Redis from 'ioredis';
import { CryptoService } from '@/common/crypto/crypto.service';
import { PrismaService } from '@/database/prisma.service';
import { REDIS_CLIENT } from '@/database/redis.module';

describe('AppModule (smoke)', () => {
  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.SESSION_SECRET = '0'.repeat(64);
  });

  it('compiles the module graph with mocked Prisma + Redis', async () => {
    const module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [
        CryptoService,
        { provide: PrismaService, useValue: mockDeep<PrismaService>() },
        { provide: REDIS_CLIENT, useValue: mockDeep<Redis>() },
      ],
    }).compile();

    expect(module).toBeDefined();
    expect(module.get(CryptoService)).toBeDefined();
    expect(module.get(PrismaService)).toBeDefined();
    expect(module.get(REDIS_CLIENT)).toBeDefined();
  });
});
