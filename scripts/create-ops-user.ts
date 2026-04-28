#!/usr/bin/env node
/**
 * Provision a new OpsUser. Prompts for password twice (hidden) and writes the
 * row with totp_enabled=false — TOTP is enrolled server-side on first login
 * via /v1/ops/auth/enrol-2fa, never on a developer laptop.
 *
 * Usage:
 *   pnpm ops:create-user --email=<email> --full-name="<name>"
 */

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

function parseArg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) return argv[i + 1];
    if (a?.startsWith(`--${name}=`)) return a.slice(`--${name}=`.length);
  }
  return undefined;
}

async function readHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error('stdin is not a TTY — cannot read password securely'));
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\n' || ch === '\r' || ch === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(buf);
          return;
        } else if (ch === '\u0003') {
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write('\n');
          process.exit(130);
        } else if (ch === '\u007f' || ch === '\b') {
          buf = buf.slice(0, -1);
        } else {
          buf += ch;
        }
      }
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const email = parseArg('email')?.toLowerCase();
  const full_name = parseArg('full-name');
  if (!email || !full_name) {
    console.error('Usage: pnpm ops:create-user --email=<email> --full-name="<name>"');
    process.exit(1);
  }

  const adapter = new PrismaPg({ connectionString: process.env['DATABASE_URL']! });
  const prisma = new PrismaClient({ adapter });

  try {
    const existing = await prisma.opsUser.findUnique({ where: { email } });
    if (existing) {
      console.error(`OpsUser with email ${email} already exists.`);
      process.exit(1);
    }

    const password = await readHidden('Password (hidden): ');
    const confirm = await readHidden('Confirm password: ');

    if (password !== confirm) {
      console.error('Passwords do not match. No changes made.');
      process.exit(1);
    }
    if (password.length === 0) {
      console.error('Password cannot be empty. No changes made.');
      process.exit(1);
    }

    const password_hash = await argon2.hash(password);
    const ops_user = await prisma.opsUser.create({
      data: {
        email,
        password_hash,
        full_name,
        totp_enabled: false,
        totp_secret: null,
      },
    });

    console.log(`Created OpsUser ${ops_user.id}. 2FA will be enrolled on first login.`);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error('FAILED:', err?.message ?? err);
  process.exit(1);
});
