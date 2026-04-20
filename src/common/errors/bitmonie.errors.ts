import { HttpException, HttpStatus } from '@nestjs/common';

export interface BitmonieErrorDetail {
  field: string;
  issue: string;
}

export class BitmonieException extends HttpException {
  public readonly code: string;
  public readonly details?: BitmonieErrorDetail[];

  constructor(
    code: string,
    message: string,
    status: HttpStatus,
    details?: BitmonieErrorDetail[],
  ) {
    super({ code, message, details }, status);
    this.code = code;
    this.details = details;
  }
}

// ── LOAN ────────────────────────────────────────────────────────

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

export class LoanKycRequiredException extends BitmonieException {
  constructor() {
    super(
      'LOAN_KYC_REQUIRED',
      'KYC verification is required before this action.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class LoanDisbursementAccountRequiredException extends BitmonieException {
  constructor() {
    super(
      'LOAN_DISBURSEMENT_ACCOUNT_REQUIRED',
      'A default disbursement account is required before creating a loan.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class LoanAmountTooLowException extends BitmonieException {
  constructor(context: { minimum_ngn: string }) {
    super(
      'LOAN_AMOUNT_TOO_LOW',
      `Loan amount is below the minimum of N${context.minimum_ngn}.`,
      HttpStatus.BAD_REQUEST,
      [{ field: 'principal_ngn', issue: `Minimum is N${context.minimum_ngn}` }],
    );
  }
}

export class LoanAmountTooHighException extends BitmonieException {
  constructor(context: { maximum_ngn: string }) {
    super(
      'LOAN_AMOUNT_TOO_HIGH',
      `Loan amount exceeds the self-serve maximum of N${context.maximum_ngn}.`,
      HttpStatus.BAD_REQUEST,
      [{ field: 'principal_ngn', issue: `Maximum is N${context.maximum_ngn}` }],
    );
  }
}

export class LoanInvalidTransitionException extends BitmonieException {
  constructor(context: { from_status: string; to_status: string }) {
    super(
      'LOAN_INVALID_TRANSITION',
      `Cannot transition loan from ${context.from_status} to ${context.to_status}.`,
      HttpStatus.CONFLICT,
    );
  }
}

export class LoanNotFoundException extends BitmonieException {
  constructor() {
    super('LOAN_NOT_FOUND', 'Loan not found.', HttpStatus.NOT_FOUND);
  }
}

// ── DISBURSEMENT ACCOUNTS ───────────────────────────────────────

export class DisbursementAccountNameMismatchException extends BitmonieException {
  constructor(context: { score: number }) {
    super(
      'DISBURSEMENT_ACCOUNT_NAME_MISMATCH',
      'Account holder name does not match your verified identity.',
      HttpStatus.UNPROCESSABLE_ENTITY,
      [{ field: 'account_unique', issue: `Match score ${context.score} below required 0.85` }],
    );
  }
}

export class DisbursementAccountMaxPerKindException extends BitmonieException {
  constructor(context: { kind: string; limit: number }) {
    super(
      'DISBURSEMENT_ACCOUNT_MAX_PER_KIND',
      `You have reached the maximum of ${context.limit} linked ${context.kind} accounts.`,
      HttpStatus.BAD_REQUEST,
      [{ field: 'kind', issue: `Maximum ${context.limit} ${context.kind} accounts per user` }],
    );
  }
}

export class DisbursementAccountDefaultDeleteException extends BitmonieException {
  constructor() {
    super(
      'DISBURSEMENT_ACCOUNT_DEFAULT_DELETE',
      'You cannot delete the sole default disbursement account for this kind. Promote another account first.',
      HttpStatus.BAD_REQUEST,
    );
  }
}

// ── KYC ─────────────────────────────────────────────────────────

export class KycAlreadyVerifiedException extends BitmonieException {
  constructor() {
    super('KYC_ALREADY_VERIFIED', 'KYC has already been verified.', HttpStatus.CONFLICT);
  }
}

export class KycUpgradeRequiredException extends HttpException {
  public readonly code = 'KYC_UPGRADE_REQUIRED';
  public readonly kyc_required = true;
  public readonly prompt_kyc: string;

  constructor(required_tier: number) {
    const prompt = `tier-${required_tier}`;
    super(
      {
        code: 'KYC_UPGRADE_REQUIRED',
        message: `This action requires KYC tier ${required_tier} verification.`,
        kyc_required: true,
        prompt_kyc: prompt,
        details: [{ field: 'kyc_tier', issue: `Required tier: ${required_tier}` }],
      },
      HttpStatus.FORBIDDEN,
    );
    this.prompt_kyc = prompt;
  }
}

export class KycBiodataMismatchException extends BitmonieException {
  constructor() {
    super(
      'KYC_BIODATA_MISMATCH',
      'The name or date of birth you provided does not match the records on your identity document.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class KycPendingException extends BitmonieException {
  constructor() {
    super(
      'KYC_PENDING',
      'Your KYC verification is under review. Please wait for approval.',
      HttpStatus.FORBIDDEN,
    );
  }
}

export class KycNotFoundException extends BitmonieException {
  constructor() {
    super('KYC_NOT_FOUND', 'KYC record not found.', HttpStatus.NOT_FOUND);
  }
}

// ── PROVIDER FAILURES ───────────────────────────────────────────

export class CollateralInvoiceFailedException extends BitmonieException {
  constructor() {
    super(
      'COLLATERAL_INVOICE_FAILED',
      'Could not create the collateral payment request.',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}

export class DisbursementTransferFailedException extends BitmonieException {
  constructor() {
    super(
      'DISBURSEMENT_TRANSFER_FAILED',
      'Could not initiate the bank transfer.',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}

// ── ACCOUNT ─────────────────────────────────────────────────────

export class AccountSuspendedException extends BitmonieException {
  constructor() {
    super(
      'ACCOUNT_SUSPENDED',
      'Your account has been suspended. Please contact support.',
      HttpStatus.FORBIDDEN,
    );
  }
}

export class DisbursementDisabledException extends BitmonieException {
  constructor() {
    super(
      'DISBURSEMENT_DISABLED',
      'Disbursements are currently disabled on your account. Please contact support.',
      HttpStatus.FORBIDDEN,
    );
  }
}

export class LoanDisabledException extends BitmonieException {
  constructor() {
    super(
      'LOAN_DISABLED',
      'Loan creation is currently disabled on your account. Please contact support.',
      HttpStatus.FORBIDDEN,
    );
  }
}

// ── AUTH ────────────────────────────────────────────────────────

export class AuthInvalidCredentialsException extends BitmonieException {
  constructor() {
    super(
      'AUTH_INVALID_CREDENTIALS',
      'Invalid email or password.',
      HttpStatus.UNAUTHORIZED,
    );
  }
}

export class AuthOtpExpiredException extends BitmonieException {
  constructor() {
    super(
      'AUTH_OTP_EXPIRED',
      'OTP has expired. Please request a new one.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class AuthOtpMaxAttemptsException extends BitmonieException {
  constructor() {
    super(
      'AUTH_OTP_MAX_ATTEMPTS',
      'Too many OTP attempts. Please try again later.',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

export class Auth2faRequiredException extends BitmonieException {
  constructor() {
    super(
      'AUTH_2FA_REQUIRED',
      'Login requires a TOTP code.',
      HttpStatus.UNAUTHORIZED,
    );
  }
}

// ── IDEMPOTENCY ─────────────────────────────────────────────────

export class IdempotencyConflictException extends BitmonieException {
  constructor() {
    super(
      'IDEMPOTENCY_CONFLICT',
      'A request with this idempotency key is already in progress.',
      HttpStatus.CONFLICT,
    );
  }
}
