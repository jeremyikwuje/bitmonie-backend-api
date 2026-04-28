import { Test, TestingModule } from '@nestjs/testing';
import { createHash } from 'crypto';
import { OpsSessionService } from '@/modules/ops/auth/ops-session.service';
import { PrismaService } from '@/database/prisma.service';
import { OPS_SESSION_TTL_SEC } from '@/common/constants';

function make_prisma() {
  return {
    opsSession: {
      create: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

describe('OpsSessionService', () => {
  let service: OpsSessionService;
  let prisma: ReturnType<typeof make_prisma>;

  beforeEach(async () => {
    prisma = make_prisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpsSessionService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(OpsSessionService);
  });

  describe('create', () => {
    it('returns an opaque hex token of expected length and stores its SHA-256', async () => {
      const token = await service.create({ ops_user_id: 'ops-uuid' });

      expect(token).toMatch(/^[0-9a-f]{64}$/);
      const expected_hash = createHash('sha256').update(token).digest('hex');
      expect(prisma.opsSession.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            ops_user_id: 'ops-uuid',
            token_hash: expected_hash,
          }),
        }),
      );
    });

    it('sets expires_at OPS_SESSION_TTL_SEC into the future (no sliding)', async () => {
      const before = Date.now();
      await service.create({ ops_user_id: 'ops-uuid' });
      const after = Date.now();

      const call = prisma.opsSession.create.mock.calls[0]![0];
      const expires_at: Date = call.data.expires_at;
      expect(expires_at.getTime()).toBeGreaterThanOrEqual(before + OPS_SESSION_TTL_SEC * 1_000);
      expect(expires_at.getTime()).toBeLessThanOrEqual(after + OPS_SESSION_TTL_SEC * 1_000);
    });

    it('persists ip_address and user_agent when provided', async () => {
      await service.create({
        ops_user_id: 'ops-uuid',
        ip_address: '1.2.3.4',
        user_agent: 'curl/8',
      });

      expect(prisma.opsSession.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            ip_address: '1.2.3.4',
            user_agent: 'curl/8',
          }),
        }),
      );
    });
  });

  describe('destroy', () => {
    it('deletes by token_hash', async () => {
      await service.destroy('abc-hash');
      expect(prisma.opsSession.deleteMany).toHaveBeenCalledWith({ where: { token_hash: 'abc-hash' } });
    });
  });

  describe('destroyAll', () => {
    it('deletes all sessions for an ops user', async () => {
      await service.destroyAll('ops-uuid');
      expect(prisma.opsSession.deleteMany).toHaveBeenCalledWith({ where: { ops_user_id: 'ops-uuid' } });
    });
  });
});
