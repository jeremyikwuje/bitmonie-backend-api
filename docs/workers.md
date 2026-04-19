# Workers

Detail doc — read when building or modifying anything in `workers/`.

All workers are standalone Node.js processes (not NestJS apps). Each is idempotent — running it twice produces the same result as running it once. Every execution posts a heartbeat to Redis (`worker:{name}:last_run`). If the heartbeat is stale by > 2 minutes, alert ops.

All worker DB queries use `FOR UPDATE SKIP LOCKED` to allow safe concurrent execution.

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

**Failure handling:** Two consecutive fetch failures set `price:stale`. This flag causes loan checkout to reject new loans with `LOAN_PRICE_STALE`. Intentional — creating a loan at a stale rate is more dangerous than blocking new loans temporarily.

---

## liquidation-monitor
**File:** `workers/liquidation-monitor/index.ts`
**Schedule:** every 30 seconds
**Purpose:** check all ACTIVE loans against current SAT/NGN. Alert at 120%, liquidate at 110%.

```
1. Fetch current SAT/NGN rate from Redis
   → If price:stale flag is set: LOG WARNING, skip all liquidations, exit cycle
   → Never liquidate at a stale rate

2. Query all loans WHERE status = 'ACTIVE'  (FOR UPDATE SKIP LOCKED)

3. For each loan:
   a. current_value_ngn = collateral_amount_sat * current_sat_ngn_rate
   b. ratio = current_value_ngn / principal_ngn

   c. IF ratio <= LIQUIDATION_THRESHOLD (1.10):
      → Inside Prisma transaction:
        1. Sell SAT via the active collateral provider at current rate
        2. Recover principal_ngn
        3. surplus_sat = collateral - amount_to_recover_principal
        4. If surplus > 0 AND release_address set:
             → Send surplus SAT to release address
        5. UPDATE loan: status = LIQUIDATED, liquidated_at, liquidation_rate_actual, surplus_released_sat
        6. logTransition(tx): LIQUIDATION_COMPLETED
        7. Notify customer: email + SMS

   d. ELSE IF ratio <= ALERT_THRESHOLD (1.20):
      → Check Redis: alert_sent:{loan_id} (24h TTL)
      → If not set: send alert email + in-app notification, SET key with 24h TTL

4. SET worker:liquidation:last_run = now()
```

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
