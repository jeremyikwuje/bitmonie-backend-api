import { Injectable } from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import { PrismaService } from '@/database/prisma.service';
import { SESSION_TTL_SEC } from '@/common/constants';

@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) {}

  async create(params: {
    user_id: string;
    ip_address?: string;
    user_agent?: string;
  }): Promise<string> {
    const token = randomBytes(32).toString('hex');
    const token_hash = createHash('sha256').update(token).digest('hex');
    const expires_at = new Date(Date.now() + SESSION_TTL_SEC * 1_000);

    await this.prisma.session.create({
      data: {
        user_id: params.user_id,
        token_hash,
        expires_at,
        ip_address: params.ip_address ?? null,
        user_agent: params.user_agent ?? null,
      },
    });

    return token;
  }

  async destroy(token_hash: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { token_hash } });
  }

  async destroyAll(user_id: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { user_id } });
  }
}
