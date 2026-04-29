# Railway deployment

One Railway service per process. All services share the same repo + Dockerfile —
each service overrides its config-as-code path to a toml in this folder.

## Services

| Service name (Railway)      | Config-as-code path                       | Runs                                                                              |
|-----------------------------|-------------------------------------------|-----------------------------------------------------------------------------------|
| `api`                       | `railway.toml` (root)                     | NestJS HTTP API                                                                   |
| `worker-price-feed`         | `railway/worker-price-feed.toml`          | SAT/NGN, BTC/NGN, USDT/NGN poller (30s)                                           |
| `worker-liquidation`        | `railway/worker-liquidation.toml`         | Liquidation monitor (30s)                                                         |
| `worker-scheduler`          | `railway/worker-scheduler.toml`           | loan-expiry + loan-reminder + disbursement-on-hold-digest + outflow-reconciler    |

The two payout-originating workers (`price-feed`, `liquidation`) stay isolated so
a crash in one doesn't take the others down. `outflow-reconciler` runs inside the
scheduler — it never *creates* a payout, it only polls providers for ground-truth
status and routes the answer through the same `OutflowsService.handleSuccess` /
`handleFailure` paths the webhook controllers use; failure mode is "stale
PROCESSING rows take an extra cycle to reconcile," not lost money.

## Creating a worker service

For each worker in the table above:

1. Railway dashboard → project → **+ New** → **GitHub Repo** → select this repo.
2. Settings → **Source** → set **Config-as-code Path** to the matching toml above.
3. Settings → **Variables** → add the same env vars as `api` (DATABASE_URL, REDIS_URL,
   provider keys, etc.). Reference the shared Postgres/Redis services Railway-style:
   `${{ Postgres.DATABASE_URL }}`, `${{ Redis.REDIS_URL }}`.
4. Deploy.

## Migrations

Migrations are run **manually**, not on service boot. After merging a migration:

```sh
railway run --service api -- node_modules/.bin/prisma migrate deploy
```

(or `prisma migrate deploy` from a workstation pointed at the prod `DATABASE_URL`).

No service start command runs `prisma migrate deploy` — the api boots straight into
`node dist/src/main`, and workers assume the schema is already migrated. Keeping
migrations out of the start command avoids the every-redeploy migrate roundtrip,
boot-time lock contention when the app scales horizontally, and accidental
migration on a rollback redeploy.

## Why per-service toml

Railway services from the same repo all build the same Dockerfile, but each needs
a different start command (`node dist/workers/<name>.worker.js`). The cleanest
config-as-code pattern is one toml per service, kept in version control here.

## Adjusting scheduler intervals

The scheduler reads the same env vars as the standalone workers — set them on
the `worker-scheduler` service:

| Env var                                      | Default        | Job                                                                            |
|----------------------------------------------|----------------|--------------------------------------------------------------------------------|
| `WORKER_LOAN_EXPIRY_INTERVAL_MS`             | `60000` (1m)   | mark `PENDING_COLLATERAL` loans `EXPIRED`                                      |
| `WORKER_LOAN_REMINDER_INTERVAL_MS`           | `3600000` (1h) | T−7d / T−1d / T / grace / final reminders                                      |
| `WORKER_DISBURSEMENT_DIGEST_INTERVAL_MS`     | `86400000` (1d)| daily digest of `ON_HOLD` disbursements                                        |
| `WORKER_OUTFLOW_RECONCILER_INTERVAL_MS`      | `60000` (1m)   | poll providers for stale `PROCESSING` outflows past `OUTFLOW_PROCESSING_STALE_SEC` (5m) |
