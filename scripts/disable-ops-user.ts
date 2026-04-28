#!/usr/bin/env node
/**
 * Disable an OpsUser and revoke all of their sessions in one transaction.
 * The OpsUser row is NOT deleted — OpsAuditLog references must survive.
 *
 * Usage:
 *   pnpm ops:disable-user --email=<email>
 */

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

function parseArg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) return argv[i + 1];
    if (a?.startsWith(`--${name}=`)) return a.slice(`--${name}=`.length);
  }
  return undefined;
}

async function main(): Promise<void> {
  const email = parseArg('email')?.toLowerCase();
  if (!email) {
    console.error('Usage: pnpm ops:disable-user --email=<email>');
    process.exit(1);
  }

  const adapter = new PrismaPg({ connectionString: process.env['DATABASE_URL']! });
  const prisma = new PrismaClient({ adapter });

  try {
    const ops_user = await prisma.opsUser.findUnique({ where: { email } });
    if (!ops_user) {
      console.error(`No OpsUser with email ${email}.`);
      process.exit(1);
    }

    const revoked = await prisma.$transaction(async (tx) => {
      await tx.opsUser.update({
        where: { id: ops_user.id },
        data: { is_active: false },
      });
      const result = await tx.opsSession.deleteMany({
        where: { ops_user_id: ops_user.id },
      });
      return result.count;
    });

    console.log(`Disabled ${email}. ${revoked} session(s) revoked.`);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error('FAILED:', err?.message ?? err);
  process.exit(1);
});
