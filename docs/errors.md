# Errors

Detail doc — read when adding a new exception or referencing the error catalog.

## Pattern

Throw typed `BitmonieException` subclasses. The `GlobalExceptionFilter` formats the standard error response shape.

```typescript
// src/common/errors/bitmonie.errors.ts
import { HttpException, HttpStatus } from '@nestjs/common';

export class BitmonieException extends HttpException {
  constructor(
    public readonly code: string,
    message: string,
    status: HttpStatus,
    public readonly details?: Array<{ field: string; issue: string }>,
  ) {
    super({ code, message, details }, status);
  }
}

export class LoanPriceStaleException extends BitmonieException {
  constructor(context: { last_updated_ms: number }) {
    super(
      'LOAN_PRICE_STALE',
      'Price feed is too stale to safely create a loan. Please try again.',
      HttpStatus.UNPROCESSABLE_ENTITY,
      [{ field: 'sat_ngn_rate', issue: `Last updated ${context.last_updated_ms}ms ago` }],
    );
  }
}

// ✅ Correct
throw new LoanPriceStaleException({ last_updated_ms: staleness_ms });

// ❌ Wrong
throw new Error('Price is stale');
throw new HttpException('Bad request', 400);
```

## GlobalExceptionFilter

```typescript
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: Record<string, unknown> = {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
    };

    if (exception instanceof BitmonieException) {
      status = exception.getStatus();
      const payload = exception.getResponse() as Record<string, unknown>;
      body = { ...payload, request_id: request.headers['x-request-id'] };
    } else if (exception instanceof ValidationPipeException) {
      status = HttpStatus.BAD_REQUEST;
      body = { code: 'VALIDATION_ERROR', message: 'Validation failed', details: exception.errors };
    }
    // Never leak stack traces — log internally, return generic shape externally

    response.status(status).json({ error: body });
  }
}
```

## Response shape

```json
{
  "error": {
    "code": "LOAN_PRICE_STALE",
    "message": "Price feed is too stale to safely create a loan. Please try again.",
    "details": [
      { "field": "sat_ngn_rate", "issue": "Last updated 4 minutes ago — threshold is 2 minutes" }
    ],
    "request_id": "req_01HX..."
  }
}
```

## HTTP status codes

- `400` — validation, business rule
- `401` — missing/invalid session
- `403` — valid session, insufficient permission
- `404` — not found
- `409` — idempotency duplicate in-flight, state machine violation
- `422` — semantic errors (stale price, KYC required)
- `429` — rate limit
- `500` — never leak stack traces

## Error codes catalog

| Code | HTTP | Meaning |
|---|---|---|
| `LOAN_PRICE_STALE` | 422 | Price feed > 2 min old |
| `LOAN_KYC_REQUIRED` | 422 | BVN/NIN verification required first |
| `LOAN_DISBURSEMENT_ACCOUNT_REQUIRED` | 422 | Default disbursement account required first |
| `LOAN_AMOUNT_TOO_LOW` | 400 | Below N50,000 minimum |
| `LOAN_AMOUNT_TOO_HIGH` | 400 | Above N10M self-serve maximum |
| `LOAN_INVALID_TRANSITION` | 409 | State machine violation |
| `LOAN_NOT_FOUND` | 404 | Loan not found or not owned by user |
| `DISBURSEMENT_ACCOUNT_NAME_MISMATCH` | 422 | Fuzzy match score < 0.85 vs BVN legal name (BANK + MOBILE_MONEY only) |
| `DISBURSEMENT_ACCOUNT_MAX_PER_KIND` | 400 | 5-per-kind limit reached |
| `DISBURSEMENT_ACCOUNT_DEFAULT_DELETE` | 400 | Cannot delete the sole default account for that kind |
| `KYC_ALREADY_VERIFIED` | 409 | Cannot re-verify |
| `COLLATERAL_INVOICE_FAILED` | 500 | Could not create collateral payment request |
| `DISBURSEMENT_TRANSFER_FAILED` | 500 | Could not initiate NGN transfer |
| `AUTH_INVALID_CREDENTIALS` | 401 | Wrong email/password |
| `AUTH_OTP_EXPIRED` | 422 | OTP expired — request a new one |
| `AUTH_OTP_MAX_ATTEMPTS` | 429 | Too many OTP attempts |
| `AUTH_2FA_REQUIRED` | 401 | Login requires TOTP code |
| `IDEMPOTENCY_CONFLICT` | 409 | Duplicate Idempotency-Key in flight |

Add new codes here before using them in code.
