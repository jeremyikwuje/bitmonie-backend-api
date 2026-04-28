# Railway deployment

One Railway service per process. All services share the same repo + Dockerfile —
each service overrides its config-as-code path to a toml in this folder.

## Services

| Service name (Railway)      | Config-as-code path                       |
|-----------------------------|-------------------------------------------|
| `api`                       | `railway.toml` (root)                     |
| `worker-price-feed`         | `railway/worker-price-feed.toml`          |
| `worker-liquidation`        | `railway/worker-liquidation.toml`         |
| `worker-loan-expiry`        | `railway/worker-loan-expiry.toml`         |
| `worker-loan-reminder`      | `railway/worker-loan-reminder.toml`       |
| `worker-outflow-reconciler` | `railway/worker-outflow-reconciler.toml`  |
| `worker-disbursement-digest`| `railway/worker-disbursement-digest.toml` |

## Creating a worker service

For each worker in the table above:

1. Railway dashboard → project → **+ New** → **GitHub Repo** → select this repo.
2. Settings → **Source** → set **Config-as-code Path** to the matching toml above.
3. Settings → **Variables** → add the same env vars as `api` (DATABASE_URL, REDIS_URL,
   provider keys, etc.). Reference the shared Postgres/Redis services Railway-style:
   `${{ Postgres.DATABASE_URL }}`, `${{ Redis.REDIS_URL }}`.
4. Deploy.

Only the `api` service runs `prisma migrate deploy` on boot. Workers assume the
schema is already migrated — never put migration commands in worker start commands.

## Why per-service toml

Railway services from the same repo all build the same Dockerfile, but each needs
a different start command (`node dist/workers/<name>.worker.js`). The cleanest
config-as-code pattern is one toml per service, kept in version control here.
