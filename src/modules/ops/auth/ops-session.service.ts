import { Injectable } from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import { PrismaService } from '@/database/prisma.service';
import { OPS_SESSION_TTL_SEC } from '@/common/constants';

@Injectable()
export class OpsSessionService {
  constructor(private readonly prisma: PrismaService) {}

  async create(params: {
    ops_user_id: string;
    ip_address?: string;
    user_agent?: string;
  }): Promise<string> {
    const token = randomBytes(32).toString('hex');
    const token_hash = createHash('sha256').update(token).digest('hex');
    const expires_at = new Date(Date.now() + OPS_SESSION_TTL_SEC * 1_000);

    await this.prisma.opsSession.create({
      data: {
        ops_user_id: params.ops_user_id,
        token_hash,
        expires_at,
        ip_address: params.ip_address ?? null,
        user_agent: params.user_agent ?? null,
      },
    });

    return token;
  }

  async destroy(token_hash: string): Promise<void> {
    await this.prisma.opsSession.deleteMany({ where: { token_hash } });
  }

  async destroyAll(ops_user_id: string): Promise<void> {
    await this.prisma.opsSession.deleteMany({ where: { ops_user_id } });
  }
}
