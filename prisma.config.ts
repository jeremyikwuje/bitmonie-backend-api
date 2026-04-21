import { PrismaPg } from '@prisma/adapter-pg';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: './prisma/schema.prisma',
  migrate: {
    async adapter(env: NodeJS.ProcessEnv) {
      return new PrismaPg({ connectionString: env['DATABASE_URL']! });
    },
  },
});
