# Architecture

Detail doc — read when scaffolding new modules, moving files, or reasoning about boundaries.
For day-to-day rules see CLAUDE.md.

---

## Project structure

Only create folders and files for in-scope modules. Do not scaffold deferred modules.

```
bitmonie-api/
├── src/
│   ├── main.ts                          # Bootstrap: global pipes, guards, filters, Swagger, CORS
│   ├── app.module.ts                    # Root module — imports all feature + provider modules
│   │
│   ├── common/                          # Shared infrastructure — used by every module
│   │   ├── constants/
│   │   │   └── index.ts                 # All financial constants — never hardcode elsewhere
│   │   ├── decorators/
│   │   │   ├── current-user.decorator.ts
│   │   │   └── raw-body.decorator.ts    # For webhook signature verification
│   │   ├── dto/
│   │   │   ├── paginated-response.dto.ts
│   │   │   └── error-response.dto.ts
│   │   ├── errors/
│   │   │   └── bitmonie.errors.ts       # All typed domain exceptions
│   │   ├── filters/
│   │   │   └── global-exception.filter.ts  # Maps exceptions → standard error schema
│   │   ├── guards/
│   │   │   ├── session.guard.ts         # Validates session cookie → attaches user to request
│   │   │   └── kyc-verified.guard.ts    # Requires KYC before proceeding
│   │   ├── interceptors/
│   │   │   ├── idempotency.interceptor.ts  # Enforces Idempotency-Key on write endpoints
│   │   │   └── logging.interceptor.ts
│   │   ├── pipes/
│   │   │   └── decimal-transform.pipe.ts   # Transforms string amounts → Decimal
│   │   └── crypto/
│   │       └── crypto.service.ts        # AES-256-GCM encrypt/decrypt for PII fields
│   │
│   ├── config/                          # @nestjs/config typed config modules
│   │   ├── app.config.ts
│   │   ├── database.config.ts
│   │   ├── redis.config.ts
│   │   └── providers.config.ts          # Credentials for all external providers
│   │
│   ├── database/
│   │   └── prisma.service.ts            # PrismaClient singleton, onModuleInit, onModuleDestroy
│   │
│   ├── providers/                       # One sub-folder per external service — shared across modules
│   │   │  # Concrete implementations live here. Interfaces stay in the module that owns the contract.
│   │   │  # Rule: a provider that serves multiple domains belongs here, not inside any single module.
│   │   │
│   │   ├── blink/
│   │   │   ├── blink.module.ts          # @Module — exports provider
│   │   │   ├── blink.provider.ts        # Implements CollateralProvider
│   │   │   └── blink.types.ts           # Zod schemas for API response validation
│   │   │
│   │   ├── palmpay/
│   │   │   ├── palmpay.module.ts        # @Module — exports provider
│   │   │   ├── palmpay.provider.ts      # Implements DisbursementProvider
│   │   │   └── palmpay.types.ts         # Zod schemas for API response validation
│   │   │
│   │   ├── qoreid/
│   │   │   ├── qoreid.module.ts         # @Module — exports provider
│   │   │   ├── qoreid.provider.ts       # Implements KycProvider
│   │   │   └── qoreid.types.ts          # Zod schemas for API response validation
│   │   │
│   │   └── quidax/
│   │       ├── quidax.module.ts         # @Module — exports provider
│   │       ├── quidax.provider.ts       # Implements PriceFeedProvider
│   │       └── quidax.types.ts          # Zod schemas for API response validation
│   │
│   └── modules/
│       │
│       │  # ── FOUNDATION ─────────────────────────────────────────────────
│       ├── auth/
│       │   ├── auth.module.ts
│       │   ├── auth.controller.ts       # POST /v1/auth/signup|login|logout|verify-email etc.
│       │   ├── auth.service.ts
│       │   ├── session.service.ts       # Session create/validate/destroy
│       │   └── dto/
│       │
│       ├── kyc/
│       │   ├── kyc.module.ts            # imports active KYC provider module; binds 'KYC_PROVIDER' token
│       │   ├── kyc.controller.ts        # POST /v1/kyc/bvn, GET /v1/kyc/status
│       │   ├── kyc.service.ts
│       │   ├── kyc.repository.ts
│       │   ├── kyc.provider.interface.ts  # KycProvider contract — owned by this domain
│       │   └── dto/
│       │
│       ├── disbursement-accounts/
│       │   ├── disbursement-accounts.module.ts
│       │   ├── disbursement-accounts.controller.ts  # CRUD /v1/disbursement-accounts
│       │   ├── disbursement-accounts.service.ts
│       │   ├── disbursement-accounts.repository.ts
│       │   ├── name-match.service.ts    # Fuzzy match account holder name vs KYC legal name
│       │   └── dto/                     # BANK + MOBILE_MONEY only; skipped for CRYPTO_ADDRESS
│       │
│       │  # ── PRICE FEED ──────────────────────────────────────────────────
│       ├── price-feed/
│       │   ├── price-feed.module.ts     # imports active price feed provider module; binds 'PRICE_FEED_PROVIDER' token
│       │   ├── price-feed.controller.ts # GET /v1/rates
│       │   ├── price-feed.service.ts
│       │   ├── price-feed.repository.ts
│       │   ├── price-feed.provider.interface.ts  # PriceFeedProvider contract
│       │   └── dto/
│       │
│       │  # ── PAYMENT MECHANICS ───────────────────────────────────────────
│       ├── payment-requests/
│       │   ├── payment-requests.module.ts   # imports active collateral provider module; binds 'COLLATERAL_PROVIDER' token
│       │   ├── payment-requests.service.ts  # Create, match, expire
│       │   ├── payment-requests.repository.ts
│       │   ├── collateral.provider.interface.ts  # CollateralProvider contract
│       │   └── dto/
│       │   # No public controller — payment requests are system-generated
│       │   # Exposed read-only under /v1/loans/:id/payment-request
│       │
│       ├── inflows/
│       │   ├── inflows.module.ts
│       │   ├── inflows.controller.ts    # GET /v1/inflows, GET /v1/inflows/:id
│       │   ├── inflows.service.ts       # Ingest + match engine
│       │   ├── inflows.repository.ts
│       │   └── dto/
│       │   # Internal POST /internal/inflows — not exposed publicly
│       │
│       ├── disbursements/
│       │   ├── disbursements.module.ts  # imports active disbursement provider module; binds 'DISBURSEMENT_PROVIDER' token
│       │   ├── disbursements.service.ts      # Business record creation
│       │   ├── disbursements.repository.ts
│       │   ├── disbursement.provider.interface.ts  # DisbursementProvider contract
│       │   ├── outflows/
│       │   │   ├── outflows.service.ts       # Execution layer — only caller of DisbursementProvider
│       │   │   └── outflows.repository.ts
│       │   └── dto/
│       │
│       │  # ── CORE PRODUCT ────────────────────────────────────────────────
│       ├── loans/
│       │   ├── loans.module.ts
│       │   ├── loans.controller.ts      # POST /v1/loans/checkout, GET /v1/loans, GET /v1/loans/:id
│       │   ├── loans.service.ts         # Lifecycle orchestration — owns the state machine
│       │   ├── loans.repository.ts
│       │   ├── calculator.service.ts    # Pure fee + collateral math — no DB, fully unit-testable
│       │   ├── loan-status.service.ts   # logTransition() — always called inside a transaction
│       │   └── dto/
│       │       ├── checkout-loan.dto.ts
│       │       ├── loan-response.dto.ts
│       │       └── loan-status-log.dto.ts
│       │
│       │  # ── WEBHOOKS (inbound from providers) ───────────────────────────
│       └── webhooks/
│           ├── webhooks.module.ts
│           ├── collateral.webhook.controller.ts   # POST /v1/webhooks/collateral
│           └── disbursement.webhook.controller.ts # POST /v1/webhooks/disbursement
│           # Controllers named by ROLE — not by provider
│           # Signature verification happens before any processing
│
├── workers/                             # Standalone Node.js processes — NOT NestJS
│   ├── price-feed/
│   │   └── index.ts                     # Poll price feed provider every 30s → DB + Redis
│   ├── liquidation-monitor/
│   │   └── index.ts                     # Check all ACTIVE loans every 30s
│   └── payment-request-expiry/
│       └── index.ts                     # Expire PENDING PaymentRequests past expires_at
│
├── prisma/
│   ├── schema.prisma                    # SINGLE SOURCE OF TRUTH for all DB models
│   └── migrations/                      # Never hand-edit — only via prisma migrate dev
│
├── test/
│   ├── unit/                            # Jest — one file per service
│   ├── integration/                     # Jest + Supertest — controller → service → DB
│   └── e2e/                             # Jest + Supertest — full loan lifecycle
│
├── docs/
│   ├── prd.md
│   ├── tdd.md
│   ├── architecture.md                  # this file
│   ├── workers.md
│   ├── conventions.md
│   ├── testing.md
│   └── errors.md
├── .env.example
├── docker-compose.yml                   # Postgres + Redis for local dev
└── CLAUDE.md
```

## Module internal structure (every module)

```
src/modules/loans/
├── loans.module.ts          # @Module — imports provider modules, declares providers/controllers
├── loans.controller.ts      # @Controller — HTTP handlers, @ApiOperation, @UseGuards
├── loans.service.ts         # @Injectable — business logic, state machine, orchestration
├── loans.repository.ts      # @Injectable — all Prisma queries for this module
├── calculator.service.ts    # @Injectable — pure math, no DB, no side effects
├── loan-status.service.ts   # @Injectable — always called inside a transaction
├── dto/
│   ├── checkout-loan.dto.ts      # @IsString(), @IsPositive() etc.
│   └── loan-response.dto.ts      # @ApiProperty() on every field
└── exceptions/
    └── loan.exceptions.ts        # Domain exceptions extending BitmonieException
```

Modules that depend on an external provider:
1. Import the provider's module from `src/providers/<name>/<name>.module.ts`
2. Bind the DI token in their own `@Module` providers array
3. The provider interface file lives in this module alongside the service that uses it

```typescript
// src/modules/kyc/kyc.module.ts
@Module({
  imports: [ActiveKycProviderModule],   // import whichever provider is active
  controllers: [KycController],
  providers: [
    KycService,
    KycRepository,
    {
      provide: 'KYC_PROVIDER',
      inject: [ConfigService, ActiveKycProvider],
      useFactory: (config: ConfigService, provider: KycProvider): KycProvider => {
        switch (config.get('providers').active.kyc) {
          case '<name>': return provider;
          default: throw new Error('Unknown KYC provider');
        }
      },
    },
  ],
  exports: [KycService],
})
export class KycModule {}
```

## main.ts bootstrap

```typescript
async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,        // required for webhook signature verification
    bufferLogs: true,
  });

  app.setGlobalPrefix('v1');

  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
  }));

  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalInterceptors(new IdempotencyInterceptor(), new LoggingInterceptor());

  const config = new DocumentBuilder()
    .setTitle('Bitmonie API')
    .setVersion('1.0')
    .addCookieAuth('session')
    .build();
  SwaggerModule.setup('v1/docs', app, SwaggerModule.createDocument(app, config));

  await app.listen(process.env.PORT ?? 3000);
}
```
