# Workers

Detail doc — read when building or modifying anything in `workers/`.

All workers are standalone Node.js processes (not NestJS apps). Each is idempotent — running it twice produces the same result as running it once. Every execution posts a heartbeat to Redis (`worker:{name}:last_run`). If the heartbeat is stale by > 2 minutes, alert ops.

All worker DB queries use `FOR UPDATE SKIP LOCKED` to allow safe concurrent execution.

## Running workers

**Dev (two terminals — API and workers stay separate so one restart doesn't kill the other):**

```bash
# terminal 1
pnpm start:dev

# terminal 2
pnpm worker:all           # all four workers via concurrently
```

Or run individual workers when iterating on one:

```bash
pnpm worker:price-feed
pnpm worker:liquidation
pnpm worker:loan-expiry
```

The API never bundles workers in-process — if the API restarts, workers keep running, and vice versa.

**Prod (Docker Compose):** `docker compose --profile prod up` builds one image and runs four services from it (`api`, `worker-price-feed`, `worker-liquidation`, `worker-loan-expiry`) — each overriding `CMD` to a different `dist/workers/*.worker.js` entry. Same pattern on any orchestrator: one image, N services, one process per service.

> **v1.2 — `loan-reminder` removed.** Loans are open-term (no due date, no maturity), so there are no due-date-cadence reminders to fire. The liquidation-monitor worker now handles all customer-facing notifications around loan health (coverage-tier nudges at 1.20 / 1.15). See [anytime-loans.md](anytime-loans.md).

---

## price-feed
**File:** `workers/price-feed/index.ts`
**Schedule:** every 30 seconds
**Purpose:** poll the active price feed provider for SAT/NGN, BTC/NGN, USDT/NGN; write to DB and Redis.

```
1. Call provider.fetchRates() — provider implementation handles API call + Zod validation
2. Validate response with Zod — if invalid, do not update cache, log error
3. INSERT row into price_feeds for each pair
4. SET Redis: price:SAT_NGN, price:BTC_NGN, price:USDT_NGN with 90s TTL
5. CLEAR price:stale flag if previously set
6. SET worker:price_feed:last_run = now()

On fetch failure:
  → SET price:stale Redis flag
  → Log error with consecutive_failures count
  → If stale for > 5 minutes: send internal alert
  → Do NOT crash — retry on next cycle
```

**Failure handling:** Two consecutive fetch failures set `price:stale`. This flag causes any rate-consuming flow (loan checkout, offramp/onramp quotes, `GET /v1/rates`) to reject with `PRICE_FEED_STALE`. Intentional — acting on a stale rate is more dangerous than blocking new requests temporarily.

---

## liquidation-monitor
**File:** `workers/liquidation-monitor.worker.ts`
**Schedule:** every 30 seconds
**Purpose:** liquidate ACTIVE loans whose collateral coverage drops below 1.10, fire customer-facing nudges at the WARN (1.20) and MARGIN_CALL (1.15) tiers, and page ops at 1.20.

```
1. Fetch current SAT/NGN rate from Redis
   → If price:stale flag is set: LOG WARNING, skip cycle (never liquidate on a stale rate)
   → If rate non-positive or unparsable: SET price:stale, page ops, abort cycle

2. Query all loans WHERE status = 'ACTIVE'  (FOR UPDATE SKIP LOCKED)
   Pull repayments for those loans in one batch query (needed for accrual).

3. For each loan:
   a. outstanding = AccrualService.compute({ loan, repayments, as_of })
   b. coverage = (collateral_sat × current_rate) / outstanding.total_outstanding_ngn

   c. Per-loan sanity: if current_rate < rate_at_creation × MIN_LIQUIDATION_RATE_FRACTION
      (default 0.5), skip + page ops. Catches single-feed glitches before they
      cascade across the book.

   d. IF coverage <= LIQUIDATION_THRESHOLD (1.10):
      → Liquidate inside a Prisma transaction:
          UPDATE loan SET status=LIQUIDATED, liquidated_at, liquidation_rate_actual
          INSERT loan_status_logs (LIQUIDATION_COMPLETED)
      → After commit, swap seized BTC to USD via Blink (best-effort; logged on failure)
      → Continue to next loan (skip nudge / ops-alert paths)

   e. Customer coverage-tier nudges (recovery-aware Redis dedupe):
      IF coverage >= COVERAGE_WARN_TIER (1.20):
        DEL coverage:warn_notified:{loan_id}, coverage:margin_call_notified:{loan_id}
      ELSE:
        SETNX coverage:warn_notified:{loan_id} → on first set, email customer (WARN)
        IF coverage >= COVERAGE_MARGIN_CALL_TIER (1.15):
          DEL coverage:margin_call_notified:{loan_id}
        ELSE:
          SETNX coverage:margin_call_notified:{loan_id} → on first set, email customer (MARGIN_CALL)

   f. Ops-internal alert (24h dedupe — separate from customer nudges):
      IF coverage <= ALERT_THRESHOLD (1.20):
        check Redis: liquidation:alert_sent:{loan_id}
        if not set: SET with 24h TTL, log structured ops alert

4. SET worker:liquidation_monitor:last_run = now()
```

The customer-tier dedupe keys carry **no TTL** — they're state, not cache. They clear on recovery (coverage rises back above the tier), so a future re-deterioration re-fires the notice once. That's why a fast oscillation around the WARN line doesn't spam the customer: only crossings (above → below) trigger a send.

---

## loan-expiry
**File:** `workers/loan-expiry/index.ts`
**Schedule:** every 60 seconds
**Purpose:** mark `PENDING_COLLATERAL` loans as `EXPIRED` if the payment-request window has passed.

```
Query:
  SELECT * FROM loans
  WHERE status = 'PENDING_COLLATERAL'
    AND <expiry condition via payment_requests join>
  FOR UPDATE SKIP LOCKED

For each expired loan (inside Prisma transaction):
  1. UPDATE loan: status = EXPIRED
  2. logTransition(tx): INVOICE_EXPIRED
  3. Notify customer: "Your loan request expired — start a new one anytime"
```
