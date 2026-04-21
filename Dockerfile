FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# ── deps: install all dependencies ──────────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

# ── builder: compile TypeScript + generate Prisma client ────────────────────
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm prisma generate
RUN pnpm build

# ── runner: production image ─────────────────────────────────────────────────
FROM node:24-alpine AS runner
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production

# Reuse the fully-built node_modules (includes generated Prisma client)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./

EXPOSE 3000
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/main"]
