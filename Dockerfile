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
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app
ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod

COPY prisma ./prisma
COPY prisma.config.ts ./
RUN pnpm prisma generate

COPY --from=builder /app/dist ./dist

EXPOSE 3000
CMD ["sh", "-c", "pnpm prisma migrate deploy && node dist/main"]
