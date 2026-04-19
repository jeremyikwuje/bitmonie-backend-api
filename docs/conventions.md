# Coding conventions — examples + tooling

Detail doc — read when uncertain about style or wiring up tooling. The rules themselves live in CLAUDE.md §6.

---

## Code examples

```typescript
// ✅ Correct — snake_case variables, camelCase method, explicit return type
async function checkoutLoan(
  user_id: string,
  input: LoanCheckoutInput,
): Promise<LoanCheckoutResult> {
  const sat_ngn_rate = await priceService.getCurrentRate('SAT_NGN');
  const collateral_sat = input.principal_ngn
    .div(sat_ngn_rate)
    .div(LOAN_LTV_PERCENT)
    .ceil();

  const { daily_fee_ngn, total_fees_ngn } = calculateFees({
    principal_ngn: input.principal_ngn,
    sat_ngn_rate,
    duration_days: input.duration_days,
  });

  return {
    loan_id: loan.id,
    collateral_amount_sat: collateral_sat,
    total_fees_ngn,
    bolt11_invoice: invoice.bolt11,
    expires_at: invoice.expires_at,
  };
}

// ✅ Correct — interface with snake_case fields
interface LoanCheckoutInput {
  principal_ngn: Decimal;
  duration_days: number;
  collateral_asset: CollateralAsset;
}

// ❌ Wrong — camelCase variable
const loanAmount = new Decimal('300000');  // use loan_amount

// ❌ Wrong — camelCase object property
return { loanId: loan.id, createdAt: loan.created_at };  // use loan_id, created_at

// ❌ Wrong — snake_case function name
async function checkout_loan() {}  // use checkoutLoan()
```

```typescript
// ✅ DTO with class-validator
export class CheckoutLoanDto {
  @ApiProperty({ example: 300000, description: 'NGN amount to borrow' })
  @IsPositive()
  @IsNumber()
  principal_ngn: number;

  @ApiProperty({ example: 7 })
  @IsInt()
  @Min(1)
  @Max(30)
  duration_days: number;

  @ApiProperty({ enum: CollateralAsset })
  @IsEnum(CollateralAsset)
  collateral_asset: CollateralAsset;
}

// ✅ Zod for external API responses
const MonierateResponseSchema = z.object({
  pair: z.string(),
  rate: z.number().positive(),
  updated_at: z.string().datetime(),
});

// ❌ Zod for DTO — use class-validator
const CheckoutLoanSchema = z.object({ principal_ngn: z.number() });
```

```typescript
// ✅ NestJS guards on controller
@Controller('loans')
@UseGuards(SessionGuard, KycVerifiedGuard)
export class LoansController {}
```

---

## Money examples

```typescript
// ✅ Correct
const collateral_sat = principal_ngn.div(sat_ngn_rate).div(LOAN_LTV_PERCENT).ceil();

// ❌ Wrong — float will betray you
const collateral_sat = principalNgn / satNgnRate / 0.80;
```

Prisma — every monetary field followed by its currency (or named with the unit):

```prisma
principal_ngn           Decimal   @db.Decimal(20, 2)   // NGN implicit in column name
collateral_amount_sat   BigInt                          // SAT implicit
settlement_amount       Decimal   @db.Decimal(20, 8)   // explicit when variable
settlement_currency     String    @db.VarChar(10)
```

---

## Status-log inside transaction

```typescript
await prisma.$transaction(async (tx) => {
  const loan = await tx.loan.create({ data: { ... } });

  await loanStatusService.logTransition(tx, {
    loan_id: loan.id,
    user_id,
    from_status: null,
    to_status: LoanStatus.PENDING_COLLATERAL,
    triggered_by: StatusTrigger.CUSTOMER,
    triggered_by_id: user_id,
    reason_code: LoanReasonCodes.LOAN_CREATED,
  });

  return loan;
});

// ❌ Wrong — separate calls, no atomicity
await prisma.loan.update({ where: { id }, data: { status: LoanStatus.ACTIVE } });
await prisma.loanStatusLog.create({ data: { ... } });
```

---

## Provider injection pattern

```typescript
// payment-requests.module.ts
@Module({
  providers: [
    PaymentRequestsService,
    PaymentRequestsRepository,
    {
      provide: 'COLLATERAL_PROVIDER',
      useClass: BlinkProvider,        // swap to QuidaxProvider in v2 with no service changes
    },
  ],
  exports: [PaymentRequestsService],
})
export class PaymentRequestsModule {}

// payment-requests.service.ts
@Injectable()
export class PaymentRequestsService {
  constructor(
    @Inject('COLLATERAL_PROVIDER')
    private readonly collateral_provider: CollateralProvider,
    private readonly repository: PaymentRequestsRepository,
  ) {}
}
```

---

## ESLint config

```json
{
  "extends": ["airbnb-typescript/base", "plugin:@typescript-eslint/recommended-type-checked"],
  "rules": {
    "camelcase": "off",
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-floating-promises": "error",
    "no-console": "error",
    "import/prefer-default-export": "off",
    "@typescript-eslint/naming-convention": [
      "error",
      { "selector": "typeLike",             "format": ["PascalCase"] },
      { "selector": "enumMember",            "format": ["SCREAMING_SNAKE_CASE"] },
      { "selector": "function",             "format": ["camelCase"] },
      { "selector": "method",               "format": ["camelCase"] },
      { "selector": "variable",             "format": ["snake_case", "UPPER_CASE"] },
      { "selector": "parameter",            "format": ["snake_case"], "leadingUnderscore": "allow" },
      { "selector": "objectLiteralProperty","format": ["snake_case"] }
    ]
  }
}
```

## Prettier config

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "arrowParens": "always"
}
```

## Import order

```typescript
// 1. Node built-ins
import { randomBytes } from 'crypto';

// 2. External packages
import { Decimal } from 'decimal.js';
import { z } from 'zod';

// 3. Internal aliases
import { db } from '@bitmonie/db';
import { LOAN_LTV_PERCENT } from '@bitmonie/shared/constants';

// 4. Relative imports
import { calculateFees } from './calculator.service';
import type { LoanCheckoutInput } from './types';
```

## Other Airbnb rules

- `const` over `let`, never `var`
- async/await over `.then()` chains
- Named functions for top-level declarations, arrow functions for callbacks
- No default exports — named exports only
- Explicit return types on all public service + controller methods
- Destructure objects/arrays where it aids readability
- NestJS decorators (`@Injectable()`, `@Controller()`) follow framework conventions
