# Bitmonie — Technical Design Document (TDD)

**Version:** 1.0 — Lightning MVP  
**Stack:** TypeScript · Node.js 24 LTS · NestJS · PostgreSQL · Redis  
**Last Updated:** 2025

---

## 1. Architecture Overview

**This is a backend REST API. There is no frontend in this repository.**

```
┌──────────────────────────────────────────────────────────────┐
│                   API CLIENTS                                │
│   Mobile App · Web Frontend · Webhook Senders (providers)   │
└───────────────────────────┬──────────────────────────────────┘
                            │ HTTPS REST / JSON
┌───────────────────────────▼──────────────────────────────────┐
│              NestJS APPLICATION  (bitmonie-api)               │
│                                                              │
│  main.ts → GlobalPipes → GlobalFilters → GlobalInterceptors  │
│                                                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐  │
│  │  Auth    │ │  Loans   │ │  Price   │ │   Webhooks     │  │
│  │ Controller│ │Controller│ │  Feed   │ │  Controller    │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────────┬───────┘  │
│       │            │            │                 │           │
│  ┌────▼─────┐ ┌────▼─────┐ ┌────▼─────┐ ┌────────▼───────┐  │
│  │  Auth    │ │  Loans   │ │  Price   │ │   Inflows      │  │
│  │ Service  │ │ Service  │ │  Service │ │   Service      │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────────┬───────┘  │
│       └────────────┴────────────┴─────────────────┘           │
│                            │                                  │
│              PrismaService (DB) + Redis                       │
└────────────────────────────┬─────────────────────────────────┘
                             │
         ┌───────────────────┼───────────────────────┐
         │                   │                       │
┌────────▼───────┐  ┌────────▼───────┐  ┌───────────▼──────┐
│   PostgreSQL   │  │     Redis      │  │  External APIs   │
│   (Prisma)     │  │  (ioredis)     │  │  External APIs   │
└────────────────┘  └────────────────┘  │  (see providers/)│
                                        └──────────────────┘

┌──────────────────────────────────────────────────────────────┐
│             STANDALONE WORKER PROCESSES                      │
│   price-feed.worker.ts  ·  liquidation-monitor.worker.ts    │
│   payment-request-expiry.worker.ts                          │
│   (Node.js processes — NOT part of the NestJS app)          │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Project Structure

```
bitmonie-api/
├── src/
│   ├── main.ts                      # Bootstrap: global pipes, filters, Swagger, CORS
│   ├── app.module.ts                # Root module
│   │
│   ├── common/                      # Shared infrastructure
│   │   ├── constants/index.ts       # Financial constants (LOAN_LTV_PERCENT, etc.)
│   │   ├── decorators/
│   │   ├── errors/bitmonie.errors.ts # Typed domain exceptions extending HttpException
│   │   ├── filters/global-exception.filter.ts
│   │   ├── guards/
│   │   │   ├── session.guard.ts
│   │   │   └── kyc-verified.guard.ts
│   │   ├── interceptors/
│   │   │   └── idempotency.interceptor.ts
│   │   └── crypto/crypto.service.ts # AES-256-GCM for PII
│   │
│   ├── config/                      # @nestjs/config typed modules
│   │
│   ├── database/
│   │   └── prisma.service.ts
│   │
│   └── modules/
│       ├── auth/
│       ├── kyc/
│       ├── disbursement-accounts/
│       ├── price-feed/
│       ├── payment-requests/        # System-generated — no public write endpoints
│       ├── inflows/
│       ├── disbursements/           # Contains outflows/ sub-module
│       ├── loans/                   # Core product module
│       └── webhooks/                # Inbound webhook controllers (role-named, not provider-named)
│
├── workers/                         # Standalone Node.js processes
│   ├── price-feed.worker.ts
│   ├── liquidation-monitor.worker.ts
│   └── payment-request-expiry.worker.ts
│
├── prisma/
│   ├── schema.prisma
│   └── migrations/
│
├── test/
│   ├── unit/
│   ├── integration/
│   └── e2e/
│
├── .env.example
├── docker-compose.yml
└── package.json
```

### Module Internal Structure

```
src/modules/loans/
├── loans.module.ts           # @Module decorator
├── loans.controller.ts       # @Controller — HTTP, @ApiOperation, @UseGuards
├── loans.service.ts          # @Injectable — business logic, state machine
├── loans.repository.ts       # @Injectable — Prisma queries only
├── calculator.service.ts     # @Injectable — pure math, no DB
├── loan-status.service.ts    # @Injectable — logTransition(), called inside transactions
├── dto/
│   ├── checkout-loan.dto.ts  # class-validator decorators
│   └── loan-response.dto.ts  # @ApiProperty decorators
└── exceptions/
    └── loan.exceptions.ts    # Domain exceptions extending BitmonieException
```

---

## 3. Database Schema (PostgreSQL via Prisma)

### Table Overview

```
Identity & Auth
  users, sessions, kycs, disbursement_accounts

Payment Mechanics (provider-agnostic)
  payment_requests   ← instruction given to customer: "send X to Y by Z"
  inflows            ← every incoming payment received (matched or unmatched)
  disbursements      ← business record: "customer is owed X"
  outflows           ← execution record: each attempt to pay the customer

Core Product
  loans              ← the loan itself — business data only, no payment mechanics

Pricing
  price_feeds

Audit & Support
  loan_status_logs, audit_logs, large_quote_enquiries
```

```prisma
// prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ─────────────────────────────────────────
// USERS
// ─────────────────────────────────────────

model User {
  id              String        @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  email           String        @unique @db.VarChar(255)
  email_verified  Boolean       @default(false)
  password_hash   String        @db.VarChar(512)
  totp_secret     String?       @db.VarChar(512)  // encrypted AES-256-GCM
  totp_enabled    Boolean       @default(false)
  created_at      DateTime      @default(now()) @db.Timestamptz
  updated_at      DateTime      @updatedAt @db.Timestamptz

  kyc                   Kyc?
  disbursement_accounts DisbursementAccount[]
  loans                 Loan[]
  payment_requests PaymentRequest[]
  inflows         Inflow[]
  disbursements   Disbursement[]
  audit_logs      AuditLog[]
  sessions        Session[]

  @@map("users")
}

model Session {
  id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  user_id     String    @db.Uuid
  user        User      @relation(fields: [user_id], references: [id], onDelete: Cascade)
  token_hash  String    @unique @db.VarChar(512)  // SHA-256 hash — raw token never stored
  expires_at  DateTime  @db.Timestamptz
  ip_address  String?   @db.VarChar(45)
  user_agent  String?   @db.VarChar(512)
  created_at  DateTime  @default(now()) @db.Timestamptz

  @@map("sessions")
}

// ─────────────────────────────────────────
// KYC
// ─────────────────────────────────────────

enum KycStatus {
  PENDING
  VERIFIED
  FAILED
  MANUAL_REVIEW

  @@map("kyc_status")
}

enum KycMethod {
  BVN
  NIN
  PASSPORT

  @@map("kyc_method")
}

model Kyc {
  id                  String      @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  user_id             String      @unique @db.Uuid
  user                User        @relation(fields: [user_id], references: [id], onDelete: Cascade)
  method              KycMethod
  status              KycStatus   @default(PENDING)

  bvn_hash            String?     @db.VarChar(512)  // SHA-256(bvn + salt) — deduplication only
  encrypted_bvn       String?     @db.VarChar(512)  // AES-256-GCM — never raw BVN

  legal_name          String      @db.VarChar(255)  // from KYC provider — used for account-holder name matching
  verified_at         DateTime?   @db.Timestamptz
  failure_reason      String?     @db.VarChar(500)
  provider_reference  String?     @db.VarChar(255)  // KYC provider's enquiry ID

  created_at          DateTime    @default(now()) @db.Timestamptz
  updated_at          DateTime    @updatedAt @db.Timestamptz

  @@map("kycs")
}

// ─────────────────────────────────────────
// DISBURSEMENT ACCOUNTS — saved payout destinations (rail-agnostic)
// `kind` discriminates BANK / MOBILE_MONEY / CRYPTO_ADDRESS.
// Generic destination columns mirror the Disbursement snapshot shape so
// snapshots copy fields directly without per-kind branching.
// ─────────────────────────────────────────

enum DisbursementAccountKind {
  BANK
  MOBILE_MONEY
  CRYPTO_ADDRESS

  @@map("disbursement_account_kind")
}

enum DisbursementAccountStatus {
  PENDING_VERIFICATION
  VERIFIED
  REJECTED

  @@map("disbursement_account_status")
}

model DisbursementAccount {
  id                  String                    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  user_id             String                    @db.Uuid
  user                User                      @relation(fields: [user_id], references: [id], onDelete: Cascade)

  kind                DisbursementAccountKind
  currency            String                    @db.VarChar(10)    // 'NGN' | 'USDT' | 'SAT' | 'BTC'

  // Generic destination — mirrors Disbursement snapshot shape
  provider_name       String                    @db.VarChar(100)   // 'GTBank' | 'MTN Nigeria' | 'USDT'
  provider_code       String                    @db.VarChar(50)    // '058' | 'MTN' | 'USDT'
  account_unique      String                    @db.VarChar(512)   // account_number | phone | address
  account_unique_tag  String?                   @db.VarChar(100)   // memo / destination tag (crypto)
  network             PaymentNetwork?                               // crypto-only; NULL for BANK / MOBILE_MONEY

  label               String?                   @db.VarChar(100)
  account_holder_name String?                   @db.VarChar(255)   // required for BANK + MOBILE_MONEY; optional for CRYPTO_ADDRESS
  name_match_score    Float?                    // fuzzy match vs KYC legal_name — populated for BANK + MOBILE_MONEY only

  is_default          Boolean                   @default(false)
  status              DisbursementAccountStatus @default(PENDING_VERIFICATION)
  verified_at         DateTime?                 @db.Timestamptz

  created_at          DateTime                  @default(now()) @db.Timestamptz
  updated_at          DateTime                  @updatedAt @db.Timestamptz

  loans               Loan[]

  // Partial unique indexes added via raw SQL in the init migration:
  //   (user_id, kind, provider_code, network, account_unique) NULLS NOT DISTINCT
  //     — dedupe destinations per user per kind; NULL network still collides for BANK / MOBILE_MONEY
  //   (user_id, kind) WHERE is_default = true
  //     — at most one default account per (user, kind)
  @@index([user_id, kind, status])
  @@map("disbursement_accounts")
}

// Kind-by-kind field mapping:
// ┌──────────────────┬────────────────┬──────────────────┬────────────────────┬──────────────┐
// │ Field            │ BANK           │ MOBILE_MONEY     │ CRYPTO_ADDRESS     │ Note         │
// ├──────────────────┼────────────────┼──────────────────┼────────────────────┼──────────────┤
// │ provider_name    │ 'GTBank'       │ 'MTN Nigeria'    │ 'USDT' (asset)     │ required     │
// │ provider_code    │ '058'          │ 'MTN'            │ 'USDT'             │ required     │
// │ account_unique   │ account number │ phone number     │ wallet address     │ required     │
// │ account_unique_tag│ NULL          │ NULL             │ memo / tag         │ optional     │
// │ network          │ NULL           │ NULL             │ TRC20 / LIGHTNING… │ crypto-only  │
// │ currency         │ 'NGN'          │ 'NGN'            │ 'USDT' / 'SAT'     │ required     │
// │ account_holder_name │ required    │ required         │ optional           │              │
// │ name-match       │ required ≥0.85 │ required ≥0.85   │ skipped            │              │
// └──────────────────┴────────────────┴──────────────────┴────────────────────┴──────────────┘

// ─────────────────────────────────────────
// PAYMENT REQUESTS
//
// An instruction given to a customer: "send X asset to Y address by Z time."
// Covers two request types:
//   COLLATERAL      — customer deposits crypto to back a loan
//   OFFRAMP_DEPOSIT — customer deposits crypto to sell (v2)
//
// A PaymentRequest expires if the customer does not act within the window.
// Expired requests can be regenerated (new row, same source_id) — the parent
// Loan or OfframpOrder stays in its current status across regenerations.
//
// A PaymentRequest is fulfilled when an Inflow is matched to it.
// ─────────────────────────────────────────

enum PaymentRequestType {
  COLLATERAL        // Crypto deposited as loan collateral
  OFFRAMP_DEPOSIT   // Crypto deposited to sell for fiat (v2)

  @@map("payment_request_type")
}

enum PaymentNetwork {
  LIGHTNING         // Bitcoin Lightning Network (SAT)
  BTC_ONCHAIN       // Bitcoin on-chain (BTC)
  TRC20             // TRON network (USDT, USDC)
  ERC20             // Ethereum network (USDT, USDC)

  @@map("payment_network")
}

enum PaymentRequestStatus {
  PENDING     // Awaiting customer payment
  PAID        // Inflow received, matched, and confirmed
  EXPIRED     // Customer did not pay within the expiry window
  CANCELLED   // Cancelled before payment

  @@map("payment_request_status")
}

model PaymentRequest {
  id                  String               @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  user_id             String               @db.Uuid

  request_type        PaymentRequestType

  // Polymorphic source — the product this request belongs to.
  // source_type = 'LOAN'          → source_id = loans.id
  // source_type = 'OFFRAMP_ORDER' → source_id = offramp_orders.id (v2)
  source_type         String               @db.VarChar(50)
  source_id           String               @db.Uuid

  // What the customer must send
  asset               String               @db.VarChar(20)   // 'SAT' | 'BTC' | 'USDT' | 'USDC'
  network             PaymentNetwork
  expected_amount     Decimal              @db.Decimal(20, 8)
  currency            String               @db.VarChar(10)   // 'SAT' | 'USDT' | 'BTC'

  // Where to send it — provider-agnostic
  receiving_address   String               @db.VarChar(512)
  // The address or identifier the customer sends to.
  // LIGHTNING:   our Lightning address or node pubkey
  // BTC_ONCHAIN: our BTC receiving address
  // TRC20/ERC20: our USDT/USDC wallet address on that network

  payment_request     String?              @db.Text
  // The formatted payment request string (optional — not all rails use it).
  // LIGHTNING: BOLT11 invoice string
  // Others:    null — receiving_address is sufficient

  // Reference from our custody/payment provider (e.g. invoice ID from Lightning provider)
  // Stored as data — column name does not reference the provider.
  provider_reference  String?              @db.VarChar(512)

  status              PaymentRequestStatus @default(PENDING)
  expires_at          DateTime             @db.Timestamptz
  // Expiry window depends on asset:
  //   SAT (Lightning BOLT11): 30 minutes (invoice hard expiry)
  //   USDT/BTC (onchain):     60 minutes (configurable — address stays valid but window closes)

  paid_at             DateTime?            @db.Timestamptz

  // FK to the Inflow that fulfilled this request — set atomically on match
  inflow_id           String?              @unique @db.Uuid

  created_at          DateTime             @default(now()) @db.Timestamptz
  updated_at          DateTime             @updatedAt @db.Timestamptz

  user                User                 @relation(fields: [user_id], references: [id])
  inflow              Inflow?              @relation(fields: [inflow_id], references: [id])

  @@index([source_type, source_id])        // "all requests for loan X"
  @@index([receiving_address])             // HOT — queried on every inbound payment event
  @@index([status, expires_at])            // expiry worker sweep
  @@index([user_id, created_at(sort: Desc)])
  @@map("payment_requests")
}

// ─────────────────────────────────────────
// INFLOWS
//
// Append-only log of every incoming payment received by Bitmonie,
// regardless of whether it matches a PaymentRequest.
//
// provider_reference carries a @unique constraint — the primary
// defence against double-processing. A duplicate tx hash or
// Lightning payment hash fails at the DB level before application code runs.
// ─────────────────────────────────────────

model Inflow {
  id                    String         @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  user_id               String?        @db.Uuid  // null if unmatched and user unknown at receipt time

  // What arrived
  asset                 String         @db.VarChar(20)    // 'SAT' | 'BTC' | 'USDT' | 'USDC'
  amount                Decimal        @db.Decimal(20, 8)
  currency              String         @db.VarChar(10)
  network               PaymentNetwork

  // Where it arrived and who sent it
  receiving_address     String         @db.VarChar(512)   // our address that received the payment
  sender_address        String?        @db.VarChar(512)   // null for Lightning (payment hash is private)

  // Deduplication — @unique prevents double-processing at the DB level
  provider_reference    String         @unique @db.VarChar(512)
  // LIGHTNING:   Lightning payment hash
  // BTC_ONCHAIN: on-chain transaction hash
  // TRC20/ERC20: on-chain transaction hash

  // On-chain confirmation tracking (null for Lightning — confirms instantly)
  confirmations_required Int?
  confirmations_received Int           @default(0)
  block_number           BigInt?
  block_timestamp        DateTime?     @db.Timestamptz

  // Matching — has this inflow been matched to a PaymentRequest?
  is_matched            Boolean        @default(false)
  matched_at            DateTime?      @db.Timestamptz

  // Denormalised after matching — enables fast audit queries without joins
  source_type           String?        @db.VarChar(50)    // 'LOAN' | 'OFFRAMP_ORDER'
  source_id             String?        @db.Uuid

  provider_response     Json?          // raw provider webhook payload — stored for reconciliation

  created_at            DateTime       @default(now()) @db.Timestamptz
  updated_at            DateTime       @updatedAt @db.Timestamptz

  user                  User?          @relation(fields: [user_id], references: [id])
  payment_request       PaymentRequest? // back-relation via payment_request.inflow_id

  @@index([receiving_address])          // HOT — queried on every inbound payment event
  @@index([provider_reference])         // dedup check on receipt
  @@index([is_matched, created_at])     // sweep job: find unmatched inflows
  @@index([source_type, source_id])     // "all inflows for loan X"
  @@index([user_id, created_at(sort: Desc)])
  @@map("inflows")
}

// ─────────────────────────────────────────
// DISBURSEMENTS + OUTFLOWS
//
// Two-layer design:
//
//   Disbursement = the business record ("customer is owed X")
//     Created once. Status managed as outflow attempts resolve.
//     Holds the destination snapshot (provider-agnostic).
//
//   Outflow = the execution record ("we attempted to pay via provider Y")
//     One row per attempt. Never updated on failure — new row per retry.
//     Holds provider-specific execution details.
//
// Disbursement (1) → Outflow (1..n)
//
// No column in either table names an external provider.
// Provider identity is stored as a DATA VALUE in outflow.processing_provider.
// ─────────────────────────────────────────

enum DisbursementType {
  LOAN_PAYOUT   // Customer receives NGN (or future crypto) from a loan
  OFFRAMP       // v2 — customer sells crypto and receives fiat or another crypto

  @@map("disbursement_type")
}

enum DisbursementRail {
  BANK_TRANSFER   // Fiat to a bank account
  MOBILE_MONEY    // Fiat to a mobile money wallet
  LIGHTNING       // Crypto via Lightning Network
  CRYPTO_ONCHAIN  // Crypto to an on-chain address

  @@map("disbursement_rail")
}

enum DisbursementStatus {
  PENDING       // Created, no outflow attempted yet
  PROCESSING    // At least one outflow in progress
  SUCCESSFUL    // An outflow confirmed delivery
  FAILED        // All outflow attempts exhausted

  @@map("disbursement_status")
}

model Disbursement {
  id                  String              @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  user_id             String              @db.Uuid

  disbursement_type   DisbursementType
  disbursement_rail   DisbursementRail

  // Polymorphic source
  // LOAN_PAYOUT → loans.id  |  OFFRAMP → offramp_orders.id (v2)
  source_type         DisbursementType
  source_id           String              @db.Uuid

  // What the customer receives — amount always paired with currency
  amount              Decimal             @db.Decimal(20, 8)
  currency            String              @db.VarChar(10)   // 'NGN' | 'USDT' | 'SAT' (future)

  // Destination snapshot — taken at disbursement creation time, self-contained forever.
  // Never JOIN back to disbursement_accounts for historical display.
  //
  // BANK_TRANSFER:  provider_name = 'GTBank'    account_unique = '0123456789'
  // MOBILE_MONEY:   provider_name = 'MTN'       account_unique = '08012345678'
  // LIGHTNING:      provider_name = 'Lightning' account_unique = 'user@wallet.com'
  // CRYPTO_ONCHAIN: provider_name = 'TRC-20'    account_unique = 'TXyz...'
  provider_name       String              @db.VarChar(255)
  account_unique      String              @db.VarChar(512)
  account_name        String?             @db.VarChar(255)  // null for crypto rails

  status              DisbursementStatus  @default(PENDING)
  failure_reason      String?             @db.VarChar(500)  // populated on terminal FAILED

  created_at          DateTime            @default(now()) @db.Timestamptz
  updated_at          DateTime            @updatedAt @db.Timestamptz

  user                User                @relation(fields: [user_id], references: [id])
  outflows            Outflow[]
  loan                Loan?               // back-relation

  @@index([user_id, created_at(sort: Desc)])
  @@index([source_type, source_id])
  @@index([status, created_at])
  @@map("disbursements")
}

enum OutflowStatus {
  PENDING       // Created, not yet submitted to provider
  PROCESSING    // Submitted, awaiting provider confirmation
  SUCCESSFUL    // Provider confirmed delivery
  FAILED        // Provider failed this attempt

  @@map("outflow_status")
}

model Outflow {
  id                  String        @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  disbursement_id     String        @db.Uuid
  user_id             String        @db.Uuid     // denormalised for fast audit queries

  attempt_number      Int           @default(1)
  // Increment per retry. A failed outflow is NEVER retried by updating its row.
  // Create a new Outflow row with attempt_number + 1.
  // All rows — succeeded and failed — are permanent audit trail.

  // Which payment processor executed this attempt.
  // Stored as DATA — never in the column name.
  // e.g. 'palmpay' | 'flutterwave' | 'paystack' | 'blink' | 'quidax'
  processing_provider String        @db.VarChar(100)

  // Execution fields — all generic, no provider names in column names
  provider_reference  String        @unique @db.VarChar(512)
  // Idempotency key — format: "{disbursement_id}:outflow:{attempt_number}"
  // @unique = DB-level double-payment guard per attempt

  provider_txn_id     String?       @db.VarChar(512)  // provider's own transaction ID
  provider_response   Json?         // full provider response — for reconciliation

  status              OutflowStatus @default(PENDING)
  failure_reason      String?       @db.VarChar(500)
  failure_code        String?       @db.VarChar(100)  // provider error code

  initiated_at        DateTime?     @db.Timestamptz   // when request sent to provider
  confirmed_at        DateTime?     @db.Timestamptz   // when provider confirmed delivery

  created_at          DateTime      @default(now()) @db.Timestamptz
  updated_at          DateTime      @updatedAt @db.Timestamptz

  disbursement        Disbursement  @relation(fields: [disbursement_id], references: [id])

  @@index([disbursement_id, attempt_number])
  @@index([processing_provider, status])   // reconciliation per provider
  @@index([status, created_at])            // ops: all pending/failed outflows
  @@map("outflows")
}

// ─────────────────────────────────────────
// PRICE FEEDS
// ─────────────────────────────────────────

enum AssetPair {
  SAT_NGN
  BTC_NGN
  USDT_NGN
  USDC_NGN
}

model PriceFeed {
  id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  pair        AssetPair
  rate_ngn    Decimal   @db.Decimal(20, 6)  // NGN per 1 unit of asset
  source      String    @db.VarChar(50)     // e.g. "quidax"
  fetched_at  DateTime  @db.Timestamptz
  created_at  DateTime  @default(now()) @db.Timestamptz

  @@index([pair, fetched_at(sort: Desc)])
  @@map("price_feeds")
}

// ─────────────────────────────────────────
// LOANS
//
// The loan business record. Holds loan terms, rates, and lifecycle
// status. Does NOT hold payment mechanics — those live in
// PaymentRequest (collateral), Inflow, Disbursement, and Outflow.
// ─────────────────────────────────────────

enum LoanStatus {
  PENDING_COLLATERAL    // Awaiting collateral — active PaymentRequest exists
  ACTIVE                // Collateral confirmed, NGN disbursed
  REPAID                // Fully repaid, collateral released
  LIQUIDATED            // Collateral sold to recover principal
  EXPIRED               // PaymentRequest expired, no collateral received
  CANCELLED             // Cancelled by customer before collateral sent
}

enum CollateralAsset {
  SAT           // v1 — Satoshis via Lightning
  // USDT       // v2
  // BTC_ONCHAIN // v2
}

enum RepaymentMethod {
  NGN
  SAT
}

model Loan {
  id                         String          @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  user_id                    String          @db.Uuid
  user                       User            @relation(fields: [user_id], references: [id])
  disbursement_account_id    String              @db.Uuid
  disbursement_account       DisbursementAccount @relation(fields: [disbursement_account_id], references: [id])

  // ── Loan terms — fixed at creation, never mutated ──────────────
  collateral_asset           CollateralAsset @default(SAT)
  collateral_amount_sat      BigInt          // SAT locked (satoshis)
  ltv_percent                Decimal         @db.Decimal(5, 2)

  principal_ngn              Decimal         @db.Decimal(20, 2)
  origination_fee_ngn        Decimal         @db.Decimal(20, 2)
  daily_fee_ngn              Decimal         @db.Decimal(20, 2)
  duration_days              Int
  total_fees_ngn             Decimal         @db.Decimal(20, 2)
  total_amount_ngn           Decimal         @db.Decimal(20, 2)  // principal + total_fees_ngn

  // ── Rates locked at creation ────────────────────────────────────
  sat_ngn_rate_at_creation   Decimal         @db.Decimal(20, 6)
  liquidation_rate_ngn       Decimal         @db.Decimal(20, 6)  // triggers liquidation
  alert_rate_ngn             Decimal         @db.Decimal(20, 6)  // triggers warning alert

  // ── Status ──────────────────────────────────────────────────────
  status                     LoanStatus      @default(PENDING_COLLATERAL)

  // ── Collateral receipt ──────────────────────────────────────────
  // Collateral payment mechanics live in PaymentRequest and Inflow.
  // This field is a denormalised convenience — set when the matched
  // Inflow is confirmed. Used by the liquidation monitor for fast queries.
  collateral_received_at     DateTime?       @db.Timestamptz

  // ── Disbursement ────────────────────────────────────────────────
  // NGN payment mechanics live in Disbursement and Outflow.
  disbursement_id            String?         @unique @db.Uuid
  disbursement               Disbursement?   @relation(fields: [disbursement_id], references: [id])

  // ── Repayment ───────────────────────────────────────────────────
  repayment_method           RepaymentMethod?
  repayment_reference        String?         @db.VarChar(512)  // bank ref, Lightning hash, etc.
  repaid_at                  DateTime?       @db.Timestamptz

  // ── Collateral release ──────────────────────────────────────────
  // Where to send collateral back after repayment or liquidation surplus.
  // v1: Lightning address  |  v2: BTC address, USDT wallet address
  collateral_release_address String?         @db.VarChar(512)
  collateral_released_at     DateTime?       @db.Timestamptz
  collateral_release_reference String?       @db.VarChar(512)  // outbound tx/payment reference

  // ── Liquidation ─────────────────────────────────────────────────
  liquidated_at              DateTime?       @db.Timestamptz
  liquidation_reference      String?         @db.VarChar(512)  // sale transaction reference
  liquidation_rate_actual    Decimal?        @db.Decimal(20, 6)
  surplus_released_sat       BigInt?         // surplus SAT returned after covering principal

  due_at                     DateTime        @db.Timestamptz   // repayment due date

  created_at                 DateTime        @default(now()) @db.Timestamptz
  updated_at                 DateTime        @updatedAt @db.Timestamptz

  status_logs                LoanStatusLog[]

  @@index([user_id, created_at(sort: Desc)])
  @@index([status])                          // liquidation monitor
  @@map("loans")
}

// ─────────────────────────────────────────
// LOAN STATUS LOGS
// Append-only. Written in the same transaction as every status change.
// ─────────────────────────────────────────

enum StatusTrigger {
  CUSTOMER                // Customer action: checkout, repayment, cancellation
  SYSTEM                  // Internal worker or scheduled job
  COLLATERAL_WEBHOOK      // Inbound webhook: collateral payment confirmed
  DISBURSEMENT_WEBHOOK    // Inbound webhook: NGN/crypto payout confirmed

  // Values describe the ROLE — not the provider.
  // The actual provider ('blink', 'palmpay', etc.) is stored in triggered_by_id.

  @@map("status_trigger")
}

model LoanStatusLog {
  id               String        @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  loan_id          String        @db.Uuid
  user_id          String        @db.Uuid    // denormalised

  from_status      LoanStatus?   // null on the first PENDING_COLLATERAL entry
  to_status        LoanStatus

  triggered_by     StatusTrigger
  triggered_by_id  String?       @db.VarChar(255)
  reason_code      String        @db.VarChar(100)
  reason_detail    String?       @db.VarChar(500)
  metadata         Json?

  created_at       DateTime      @default(now()) @db.Timestamptz

  loan             Loan          @relation(fields: [loan_id], references: [id])

  @@index([loan_id, created_at])
  @@index([user_id, created_at])
  @@map("loan_status_logs")
}

// ─────────────────────────────────────────
// AUDIT LOGS — INSERT ONLY
// ─────────────────────────────────────────

model AuditLog {
  id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  user_id     String?   @db.Uuid
  user        User?     @relation(fields: [user_id], references: [id])
  action      String    @db.VarChar(255)
  resource    String?   @db.VarChar(255)
  ip_address  String?   @db.VarChar(45)
  user_agent  String?   @db.VarChar(512)
  metadata    Json?
  created_at  DateTime  @default(now()) @db.Timestamptz

  @@index([user_id, created_at])
  @@index([action, created_at])
  @@map("audit_logs")
}

// ─────────────────────────────────────────
// LARGE LOAN ENQUIRIES (> N10M)
// ─────────────────────────────────────────

model LargeQuoteEnquiry {
  id                String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  name              String    @db.VarChar(255)
  phone             String    @db.VarChar(20)
  email             String    @db.VarChar(255)
  loan_amount_ngn   Decimal   @db.Decimal(20, 2)
  collateral_type   String    @db.VarChar(50)   // 'SAT' | 'BTC' | 'USDT' | 'CAR' | 'IPHONE'
  preferred_contact String    @db.VarChar(20)   // 'whatsapp' | 'call' | 'email'
  notes             String?   @db.VarChar(1000)
  status            String    @default("PENDING") @db.VarChar(20)
  created_at        DateTime  @default(now()) @db.Timestamptz
  updated_at        DateTime  @updatedAt @db.Timestamptz

  @@map("large_quote_enquiries")
}
```

---

## 4. Redis Usage

```
Key Pattern                                   TTL     Purpose
──────────────────────────────────────────────────────────────────────
price:SAT_NGN                                 90s     Latest SAT/NGN rate
price:BTC_NGN                                 90s     Latest BTC/NGN rate
price:USDT_NGN                                90s     Latest USDT/NGN rate
price:stale                                   —       Set if feed > 2 min old

session:{token_hash}                          24h     Session existence check
otp:{email}                                   10min   Email OTP (6-digit, max 5 attempts)
rate_limit:auth:{ip}                          15min   Auth endpoint rate limiting
rate_limit:api:{user_id}                      1min    Authenticated API rate limiting

payment_request:pending:{receiving_address}   35min   Active request for quick inflow matching
// Redundant to DB index but avoids a DB hit on every inbound payment event.
// TTL = request expires_at + 5min grace. Invalidated when matched or expired.

liquidation:active_loans                      —       Set of ACTIVE loan IDs for monitor
liquidation:alert_sent:{loan_id}              24h     Prevent duplicate liquidation alerts

worker:price_feed:last_run                    —       Heartbeat for price feed worker
worker:liquidation:last_run                   —       Heartbeat for liquidation monitor
worker:payment_request_expiry:last_run        —       Heartbeat for expiry worker
```

---

## 5. External Integrations

All providers live in `src/providers/<name>/` — outside feature modules. Each implements one of four role interfaces. The active provider per role is selected by an env var (`PRICE_FEED_PROVIDER`, `COLLATERAL_PROVIDER`, `DISBURSEMENT_PROVIDER`, `KYC_PROVIDER`). The feature module factory reads the selector and returns the matching injectable — nothing in the service layer changes when a provider is swapped.

**Provider structure:** `src/providers/<name>/` contains three files:
- `<name>.provider.ts` — implements the role interface; constructor takes a plain config object so it can be instantiated from both NestJS modules and standalone workers
- `<name>.module.ts` — NestJS module that creates the provider via `useFactory` reading `providers.config.ts`
- `<name>.types.ts` — Zod schemas for validating that provider's API response shape

**Role interfaces** (each defined in the module that owns the contract):

```typescript
// src/modules/price-feed/price-feed.provider.interface.ts
interface PriceFeedProvider {
  fetchRates(): Promise<RateResult[]>;
}

// src/modules/payment-requests/collateral.provider.interface.ts
interface CollateralProvider {
  createPaymentRequest(params): Promise<{ provider_reference, payment_request, receiving_address, expires_at }>;
  sendToAddress(params): Promise<string>;                     // returns provider_reference
  verifyWebhookSignature(raw_body, signature): boolean;       // called on RAW body before JSON.parse
}

// src/modules/disbursements/disbursement.provider.interface.ts
interface DisbursementProvider {
  initiateTransfer(params): Promise<{ provider_txn_id, provider_response }>;
  getTransferStatus(provider_reference): Promise<{ status, failure_reason?, failure_code? }>;
  verifyWebhookSignature(raw_body, signature): boolean;       // IP allowlist + HMAC on RAW body
}

// src/modules/kyc/kyc.provider.interface.ts
interface KycProvider {
  verifyBvn(bvn): Promise<{ legal_name, provider_reference }>;
  verifyNin(nin): Promise<{ legal_name, provider_reference }>;
}
```

**Webhook endpoints** are named by role, not provider: `POST /v1/webhooks/collateral`, `POST /v1/webhooks/disbursement`.

**Disbursement provider** is only ever called from `OutflowsService` — never directly from any other service.

### 5.5 Loan Lifecycle — How the Modules Wire Together

```
POST /v1/loans/checkout (SessionGuard + KycVerifiedGuard)
  → LoansController → LoansService.checkoutLoan()
  → CalculatorService.calculateFees() [pure math]
  → PaymentRequestsService.create()
     → CollateralProvider.createPaymentRequest()
     → PaymentRequest saved to DB
     → receiving_address cached in Redis
  → Loan created, LoanStatusLog written [same transaction]
  → Response: { loan_id, payment_request, receiving_address, expires_at, fee_breakdown }

POST /v1/webhooks/collateral (raw body, no auth guard — signature verified first)
  → CollateralWebhookController
  → signature verified on RAW body
  → InflowsService.ingest()
     → Inflow INSERT (provider_reference @unique → dedup guard)
     → PaymentRequestsService.matchInflow()
        → Atomic transaction: PaymentRequest → PAID, Inflow → matched
        → Loan → ACTIVE, collateral_received_at set
        → LoanStatusLog written
        → DisbursementsService.createForLoan()
           → Disbursement created
           → OutflowsService.dispatch()
              → DisbursementProvider.initiateTransfer()
              → Outflow created, Disbursement → PROCESSING

POST /v1/webhooks/disbursement (raw body, no auth guard — signature + IP verified first)
  → DisbursementWebhookController
  → OutflowsService.handleProviderConfirmation()
     → Outflow → SUCCESSFUL, Disbursement → SUCCESSFUL
     → Loan → ACTIVE (already was, no change)
     → LoanStatusLog: DISBURSEMENT_CONFIRMED
```

---

## 6. Loan Lifecycle State Machine

```
                  ┌──────────────────────┐
                  │  PENDING_COLLATERAL  │ ← loan + PaymentRequest created
                  └──────────┬───────────┘
                             │ Inflow matched + confirmed (COLLATERAL_WEBHOOK)
                             ▼
                  ┌──────────────────────┐
                  │       ACTIVE         │ ← collateral confirmed, NGN disbursed
                  └──────────┬───────────┘
          ┌───────────────────┼─────────────────┐
          │                   │                 │
   Rate < 110% LTV     Customer repays    PaymentRequest
   (liquidation         (NGN or SAT)        expired,
    monitor)                               no collateral
          │                   │                 │
          ▼                   ▼                 ▼
   ┌────────────┐       ┌─────────┐      ┌──────────┐
   │ LIQUIDATED │       │ REPAID  │      │ EXPIRED  │
   └────────────┘       └─────────┘      └──────────┘

  CANCELLED — customer cancels before sending collateral
```

**Terminal states:** `REPAID`, `LIQUIDATED`, `EXPIRED`, `CANCELLED` — no further transitions.
Every transition writes to `loan_status_logs` atomically in the same Prisma transaction.

---

## 7. Loan Checkout Flow

```typescript
// src/modules/loans/loans.service.ts — checkoutLoan()

async function checkoutLoan(
  user_id: string,
  dto: CheckoutLoanDto,
): Promise<CheckoutLoanResponseDto> {
  // 1. Assert user KYC verified (or KycVerifiedGuard handles this at controller level)
  // 2. Assert user has a default bank account
  // 3. Fetch live SAT/NGN rate from Redis — throw LoanPriceStaleException if stale
  // 4. CalculatorService.calculateFees() — pure math, Decimal throughout
  // 5. Prisma.$transaction():
  //    a. INSERT loan (status: PENDING_COLLATERAL)
  //    b. INSERT loan_status_log (LOAN_CREATED)
  // 6. PaymentRequestsService.create():
  //    a. CollateralProvider.createPaymentRequest()
  //    b. INSERT payment_request with provider_reference + expires_at
  //    c. Cache receiving_address in Redis (35min TTL)
  // 7. Return { loan_id, payment_request, receiving_address, expires_at, fee_breakdown }
}

// All monetary calculations use Decimal — never number.
```

---

## 8. Liquidation Monitor (Worker)

```typescript
// workers/liquidation-monitor.worker.ts

async function runLiquidationCheck(): Promise<void> {
  // 1. Fetch current SAT/NGN rate from Redis
  //    → If price:stale is set: LOG WARNING, skip cycle entirely — never liquidate on stale rates
  // 2. Query: SELECT * FROM loans WHERE status = 'ACTIVE' FOR UPDATE SKIP LOCKED
  // 3. For each active loan:
  //    a. current_value_ngn = loan.collateral_amount_sat * current_rate  [Decimal]
  //    b. ratio = current_value_ngn / loan.principal_ngn
  //    c. IF ratio <= 1.10 (LIQUIDATION_THRESHOLD):
  //       → CollateralProvider.sendToAddress() to sell / liquidate SAT
  //       → Recover principal_ngn
  //       → Compute surplus_sat = collateral - amount_needed_to_cover_principal
  //       → IF surplus_sat > 0 AND collateral_release_address:
  //            CollateralProvider.sendToAddress(collateral_release_address, surplus_sat)
  //       → Prisma.$transaction():
  //            UPDATE loan: status = LIQUIDATED, liquidated_at, liquidation_rate_actual
  //            INSERT loan_status_log: LIQUIDATION_COMPLETED
  //       → Notify customer (email + SMS)
  //    d. IF ratio <= 1.20 (ALERT_THRESHOLD):
  //       → Check Redis alert_sent:{loan_id} — skip if set (24h cooldown)
  //       → Send alert notification
  //       → SET alert_sent:{loan_id} with 24h TTL
  // 4. SET worker:liquidation:last_run = now()
}

// Schedule: setInterval every 30s
// Crash recovery: PM2 / Docker restart policy
// Alerting: if worker:liquidation:last_run stale > 2min → page on-call
```

---

## 9. Security Architecture

### 9.1 Authentication (NestJS SessionGuard)

```typescript
// src/common/guards/session.guard.ts
@Injectable()
export class SessionGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = request.cookies['session'];
    if (!token) throw new UnauthorizedException();

    const token_hash = sha256(token);
    const session = await this.prisma.session.findUnique({ where: { token_hash } });
    if (!session || session.expires_at < new Date()) throw new UnauthorizedException();

    request.user = await this.prisma.user.findUnique({ where: { id: session.user_id } });
    return true;
  }
}
```

- Tokens: 32-byte cryptographically random, stored as SHA-256 hash — raw token never in DB
- Email OTP: 6-digit, 10-minute TTL, Redis, max 5 attempts
- 2FA: TOTP (RFC 6238), secret encrypted AES-256-GCM
- Passwords: Argon2id (memory: 64MB, iterations: 3, parallelism: 4)

### 9.2 Sensitive Data

| Field | Storage | Rule |
|---|---|---|
| BVN | AES-256-GCM encrypted | Key in env — never raw in DB |
| BVN dedup | SHA-256(bvn + salt) hash | For deduplication only |
| TOTP secret | AES-256-GCM encrypted | Never returned in any response |
| Session token | SHA-256 hash only | Raw token in cookie only — never DB |
| Provider secrets | Environment vars only | Never in codebase or DB |

### 9.3 NestJS Security Stack

```typescript
// main.ts bootstrap — applied globally in order

app.use(helmet());                      // Security headers, HSTS
app.use(cookieParser());
app.enableCors({ credentials: true, origin: process.env.ALLOWED_ORIGIN });

// Rate limiting via @nestjs/throttler
// Auth: 10 req/min per IP
// API: 60 req/min per user
// Webhooks: IP allowlist only

// Webhook controllers: @UseInterceptors(RawBodyInterceptor)
// Raw body preserved for HMAC signature verification
// JSON.parse() happens AFTER signature check — never before

// Input validation: ValidationPipe (global) with whitelist + forbidNonWhitelisted
// SQL injection: Prisma parameterised queries only — never raw string SQL
// Output: GlobalExceptionFilter strips stack traces from all error responses
```

### 9.4 Webhook Security

- All inbound webhooks: signature verified on **raw `Buffer` body** before `JSON.parse()`
- Collateral webhooks: HMAC-SHA256 with `COLLATERAL_PROVIDER_WEBHOOK_SECRET`
- Disbursement webhooks: IP allowlist + HMAC-SHA256 with `DISBURSEMENT_PROVIDER_WEBHOOK_SECRET`
- Webhook handlers idempotent — `provider_reference @unique` is the DB-level dedup guard

---

## 10. REST API Endpoints

```
# AUTH (no guard)
POST   /v1/auth/signup
POST   /v1/auth/login
POST   /v1/auth/logout
POST   /v1/auth/verify-email
POST   /v1/auth/resend-verification
POST   /v1/auth/forgot-password
POST   /v1/auth/reset-password
POST   /v1/auth/2fa/enable        # SessionGuard
POST   /v1/auth/2fa/confirm       # SessionGuard
POST   /v1/auth/2fa/disable       # SessionGuard

# KYC (SessionGuard)
POST   /v1/kyc/bvn
POST   /v1/kyc/nin
GET    /v1/kyc/status

# DISBURSEMENT ACCOUNTS (SessionGuard + KycVerifiedGuard)
GET    /v1/disbursement-accounts
POST   /v1/disbursement-accounts
DELETE /v1/disbursement-accounts/:id
PATCH  /v1/disbursement-accounts/:id/set-default

# RATES (public)
GET    /v1/rates

# LOANS (SessionGuard + KycVerifiedGuard unless noted)
POST   /v1/loans/checkout
GET    /v1/loans
GET    /v1/loans/:id                           # includes status_timeline + active payment_request
GET    /v1/loans/:id/payment-request           # current active PaymentRequest
POST   /v1/loans/:id/set-release-address
POST   /v1/loans/:id/repay                     # NGN or SAT
POST   /v1/loans/:id/cancel
GET    /v1/loans/calculate                     # public — no guard (loan quote calculator)

# ENQUIRY (public)
POST   /v1/enquiries/large-loan

# WEBHOOKS (no session guard — signature verified instead)
POST   /v1/webhooks/collateral                 # inbound: collateral payment confirmed
POST   /v1/webhooks/disbursement               # inbound: NGN/crypto disbursement confirmed

# INTERNAL (not exposed publicly — called by workers or internal services)
POST   /internal/inflows                       # ingest inbound payment event

# DOCS (non-production only)
GET    /v1/docs                                # Swagger UI
```

---

## 11. Environment Variables

Canonical reference: `.env.example` — always check that file for the current list.

Key groups:
- **Application:** `NODE_ENV`, `PORT`, `API_BASE_URL`
- **Database:** `DATABASE_URL`, `REDIS_URL`
- **Auth:** `SESSION_SECRET`, `ENCRYPTION_KEY`
- **Provider selectors** — change the value to swap the active implementation:
  `PRICE_FEED_PROVIDER`, `COLLATERAL_PROVIDER`, `DISBURSEMENT_PROVIDER`, `KYC_PROVIDER`
- **Per-provider credentials** — one named block per concrete provider in `src/providers/`
- **Worker intervals:** `WORKER_PRICE_FEED_INTERVAL_MS`, `WORKER_LIQUIDATION_INTERVAL_MS`, `WORKER_PAYMENT_REQUEST_EXPIRY_INTERVAL_MS`
- **Observability:** `LOG_LEVEL`, `INTERNAL_ALERT_EMAIL`
```

---

## 12. Testing Strategy

```
Unit tests       test/unit/**/*.service.spec.ts
                 Pure business logic: calculations, fee math, name matching,
                 state machine transitions. Mock all dependencies with Jest.
                 Tool: Jest + jest-mock-extended

Integration      test/integration/**/*.spec.ts
                 Controller → Service → real test DB (Prisma transactions rolled back after each test)
                 External providers mocked via NestJS DI overrides.
                 Tool: Jest + Supertest + @nestjs/testing

E2E              test/e2e/**/*.e2e-spec.ts
                 Full loan lifecycle end-to-end against test DB.
                 Provider webhooks simulated by calling internal endpoints directly.
                 Tool: Jest + Supertest
```

### Critical Tests (Must Exist Before Shipping)

```typescript
// calculator.service.spec.ts
describe('CalculatorService', () => {
  it('applies 80% LTV correctly')
  it('calculates daily fee as N500 per $100 USD equivalent')
  it('adds origination fee to total')
  it('computes liquidation threshold at 110% of principal')
  it('uses Decimal — no float imprecision')
})

// loans.service.spec.ts
describe('LoansService', () => {
  it('throws LoanPriceStaleException when rate is stale')
  it('throws LoanKycRequiredException when user not verified')
  it('throws LoanDisbursementAccountRequiredException when no default disbursement account')
  it('creates loan with PENDING_COLLATERAL status')
  it('writes loan_status_log in same transaction as loan creation')
  it('calls PaymentRequestsService.create() after loan created')
  it('throws LoanInvalidTransitionException on backward state change')
  it('duplicate checkout with same Idempotency-Key returns same response')
})

// loans.controller.spec.ts (integration, Supertest)
describe('POST /v1/loans/checkout', () => {
  it('returns 401 without session cookie')
  it('returns 422 when price feed is stale')
  it('returns 201 with payment_request on success')
  it('returns same 201 on duplicate Idempotency-Key')
})

// collateral.webhook.controller.spec.ts
describe('POST /v1/webhooks/collateral', () => {
  it('returns 401 on invalid signature')
  it('advances loan to ACTIVE on valid webhook')
  it('is idempotent — duplicate webhook produces same result')
})

// liquidation-monitor.worker.spec.ts
describe('LiquidationMonitor', () => {
  it('skips liquidation when price:stale flag is set')
  it('triggers liquidation at exactly 110% threshold')
  it('sends alert at exactly 120% threshold')
  it('does not double-alert within 24h for same loan')
  it('returns surplus SAT to collateral_release_address')
})
```

---

## 13. Deployment

```yaml
# Recommended: Railway / Render / Fly.io at launch — AWS ECS at scale

Services:
  - api:                    NestJS app (horizontally scalable)
  - price-feed-worker:      Node.js process (always-on, 1 instance)
  - liquidation-worker:     Node.js process (always-on, 1 instance, CRITICAL)
  - payment-request-expiry: Node.js process (always-on, 1 instance)

Database:
  - PostgreSQL 16 (managed — Railway / Supabase / RDS)
  - Point-in-time recovery enabled, daily backups

Cache:
  - Redis 7 (managed — Upstash / Railway)

Monitoring:
  - Uptime:           BetterStack / UptimeRobot
  - Errors:           Sentry (@sentry/nestjs)
  - Structured logs:  Logtail / Datadog (pino JSON → log shipper)
  - Worker heartbeat: Alert if worker:*:last_run stale > 2min (ops email + Slack)
```