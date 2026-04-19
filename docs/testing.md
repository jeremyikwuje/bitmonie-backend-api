# Testing patterns

Detail doc — read when writing tests.

## Approach (TDD)

1. Write the test first
2. Confirm it fails before implementing
3. Write minimum code to make it pass
4. Refactor with tests still passing

| Type | Location | Tool | Coverage target |
|---|---|---|---|
| Unit | `test/unit/` | Jest | 80%+ on all service files |
| Integration | `test/integration/` | Jest + Supertest | All controller → service → DB flows |
| E2E | `test/e2e/` | Jest + Supertest | Full loan lifecycle against test DB |

```bash
pnpm test              # unit
pnpm test:integration  # requires running DB
pnpm test:e2e          # full lifecycle
pnpm test:cov          # coverage
```

---

## Unit test pattern (mock all deps)

```typescript
// test/unit/loans/calculator.service.spec.ts
describe('CalculatorService', () => {
  let service: CalculatorService;

  beforeEach(() => {
    service = new CalculatorService();  // pure math — no deps
  });

  it('applies 80% LTV correctly', () => {
    const result = service.calculateCollateral({
      principal_ngn: new Decimal('300000'),
      sat_ngn_rate: new Decimal('1410'),
    });
    // collateral = (300000 / 1410) / 0.80 = 265.957... → ceil
    expect(result.collateral_amount_sat).toBe(BigInt(266));
  });
});

// test/unit/loans/loans.service.spec.ts
describe('LoansService', () => {
  let service: LoansService;
  let prisma: DeepMockProxy<PrismaService>;
  let price_feed: jest.Mocked<PriceFeedService>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        LoansService,
        { provide: PrismaService,        useValue: mockDeep<PrismaService>() },
        { provide: PriceFeedService,     useValue: { getCurrentRate: jest.fn() } },
        { provide: LoanStatusService,    useValue: { logTransition: jest.fn() } },
      ],
    }).compile();

    service    = module.get(LoansService);
    prisma     = module.get(PrismaService);
    price_feed = module.get(PriceFeedService);
  });

  it('rejects checkout when price feed is stale', async () => {
    price_feed.getCurrentRate.mockRejectedValue(
      new LoanPriceStaleException({ last_updated_ms: 200000 }),
    );
    await expect(service.checkoutLoan(user_id, dto))
      .rejects.toBeInstanceOf(LoanPriceStaleException);
  });
});
```

## Integration test pattern (Supertest + real DB)

```typescript
// test/integration/loans/loans.controller.spec.ts
describe('POST /v1/loans/checkout', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    })
    .overrideProvider('COLLATERAL_PROVIDER')
    .useValue(mockCollateralProvider)
    .compile();

    app = module.createNestApplication();
    await app.init();
  });

  it('returns 422 when user has no default disbursement account', async () => {
    await request(app.getHttpServer())
      .post('/v1/loans/checkout')
      .set('Cookie', session_cookie)
      .set('Idempotency-Key', uuid())
      .send({ principal_ngn: 300000, duration_days: 7, collateral_asset: 'SAT' })
      .expect(422)
      .expect(res => {
        expect(res.body.error.code).toBe('LOAN_DISBURSEMENT_ACCOUNT_REQUIRED');
      });
  });
});
```

---

## Critical test cases (must exist before shipping)

```
calculator.test.ts:
  ✓ 80% LTV applied correctly
  ✓ Fee is N500 per $100 USD equivalent per day
  ✓ Origination fee N500 added to total
  ✓ Liquidation rate calculated at 110% of principal
  ✓ Alert rate calculated at 120% of principal
  ✓ All values use Decimal — no float imprecision
  ✓ SAT/BTC conversion is precise to 8 decimal places

loan.service.test.ts:
  ✓ Rejects checkout if user not KYC verified
  ✓ Rejects checkout if no default disbursement account
  ✓ Rejects checkout if price feed is stale
  ✓ Creates loan with PENDING_COLLATERAL status
  ✓ Writes loan_status_log on creation in same transaction
  ✓ Creates collateral payment request for exact SAT amount
  ✓ Transitions to ACTIVE on collateral confirmation — with status log
  ✓ Triggers disbursement after ACTIVE
  ✓ Transitions to REPAID on full repayment — with status log
  ✓ Releases collateral on repayment
  ✓ Transitions to EXPIRED if payment request not paid in 30 min — with status log
  ✓ Throws LoanInvalidTransitionException on backward transition attempt
  ✓ Duplicate collateral webhook is idempotent — second call is a no-op
  ✓ Duplicate disbursement webhook is idempotent — no double disbursement

liquidation.test.ts:
  ✓ Liquidation triggered at exactly 110% collateral-to-loan ratio
  ✓ Alert sent at exactly 120% collateral-to-loan ratio
  ✓ No double alert within 24h window for same loan
  ✓ Surplus SAT returned to release address after liquidation
  ✓ Already-liquidated loans are skipped
  ✓ Stale price feed skips all liquidations — logs warning

disbursement-accounts.service.test.ts:
  ✓ Max 5 per kind enforced (BANK, MOBILE_MONEY, CRYPTO_ADDRESS independently)
  ✓ Name match score < 85% rejects account (BANK + MOBILE_MONEY)
  ✓ Name match score >= 85% accepts account (BANK + MOBILE_MONEY)
  ✓ Name match is skipped entirely for CRYPTO_ADDRESS
  ✓ Cannot delete sole default account for a kind
  ✓ Auto-promotes next account of same kind when default is deleted
  ✓ Duplicate (user, kind, provider_code, network, account_unique) rejected
```
