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

export class PriceFeedStaleException extends BitmonieException {
  constructor(context: { last_updated_ms: number; pair?: string }) {
    super(
      'PRICE_FEED_STALE',
      'Price feed is too stale. Please try again.',
      HttpStatus.UNPROCESSABLE_ENTITY,
      [{ field: context.pair ?? 'rate', issue: `Last updated ${context.last_updated_ms}ms ago` }],
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

export class LoanDurationInvalidException extends BitmonieException {
  constructor(context: { min: number; max: number }) {
    super(
      'LOAN_DURATION_INVALID',
      `Loan duration must be between ${context.min} and ${context.max} days.`,
      HttpStatus.BAD_REQUEST,
      [{ field: 'duration_days', issue: `Must be ${context.min}–${context.max} days` }],
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

export class LoanNotActiveException extends BitmonieException {
  constructor(context: { status: string }) {
    super(
      'LOAN_NOT_ACTIVE',
      'Loan is not active.',
      HttpStatus.CONFLICT,
      [{ field: 'status', issue: `Loan is ${context.status}; repayments only credit to ACTIVE loans` }],
    );
  }
}

export class InflowBelowFloorException extends BitmonieException {
  constructor(context: { received_ngn: string; floor_ngn: string }) {
    super(
      'INFLOW_BELOW_FLOOR',
      'Repayment amount is below the minimum partial repayment floor.',
      HttpStatus.UNPROCESSABLE_ENTITY,
      [{ field: 'amount_ngn', issue: `Received ${context.received_ngn} but minimum is ${context.floor_ngn}` }],
    );
  }
}

export class PendingLoanAlreadyExistsException extends BitmonieException {
  constructor() {
    super(
      'LOAN_PENDING_ALREADY_EXISTS',
      'You already have a loan awaiting collateral. Pay its invoice or cancel it before starting a new loan.',
      HttpStatus.CONFLICT,
    );
  }
}

export class AddCollateralAlreadyPendingException extends BitmonieException {
  constructor() {
    super(
      'ADD_COLLATERAL_ALREADY_PENDING',
      'A collateral top-up is already pending for this loan. Wait for it to expire or be received.',
      HttpStatus.CONFLICT,
    );
  }
}

export class NoUnmatchedInflowException extends BitmonieException {
  constructor() {
    super(
      'NO_UNMATCHED_INFLOW',
      'No unmatched repayment inflow found for this user in the last 24 hours.',
      HttpStatus.NOT_FOUND,
    );
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

// ── DISBURSEMENT (ops) ──────────────────────────────────────────
//
// Disbursement is the obligation; it never auto-fails. Outflows fail per
// attempt; the parent Disbursement lands in ON_HOLD and waits for an ops
// decision. Retry creates a NEW Outflow (attempt_number + 1); cancel is
// terminal. See CLAUDE.md §5.6.

export class DisbursementNotFoundException extends BitmonieException {
  constructor() {
    super(
      'DISBURSEMENT_NOT_FOUND',
      'Disbursement not found.',
      HttpStatus.NOT_FOUND,
    );
  }
}

export class DisbursementNotOnHoldException extends BitmonieException {
  constructor(context: { status: string }) {
    super(
      'DISBURSEMENT_NOT_ON_HOLD',
      'Disbursement is not on hold; only on-hold disbursements can be retried.',
      HttpStatus.CONFLICT,
      [{ field: 'status', issue: `Disbursement is ${context.status}` }],
    );
  }
}

export class DisbursementTerminalException extends BitmonieException {
  constructor(context: { status: string }) {
    super(
      'DISBURSEMENT_TERMINAL',
      'Disbursement is in a terminal state and cannot be modified.',
      HttpStatus.CONFLICT,
      [{ field: 'status', issue: `Disbursement is ${context.status}` }],
    );
  }
}

// Used by the ops "abandon attempt" endpoint when the disbursement has no
// in-flight (PENDING/PROCESSING) outflow to abandon — there's nothing to act
// on, so 409 instead of silently no-op'ing.
export class DisbursementNoActiveOutflowException extends BitmonieException {
  constructor() {
    super(
      'DISBURSEMENT_NO_ACTIVE_OUTFLOW',
      'Disbursement has no in-flight outflow to abandon.',
      HttpStatus.CONFLICT,
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

// ── OPS ─────────────────────────────────────────────────────────

export class OpsInvalidCredentialsException extends BitmonieException {
  constructor() {
    super(
      'OPS_INVALID_CREDENTIALS',
      'Invalid email or password.',
      HttpStatus.UNAUTHORIZED,
    );
  }
}

// Step 1 of login succeeded; client must call /v1/ops/auth/verify-2fa with
// the challenge_id. Carries the challenge_id in `details` so the controller
// can surface it without a special-cased success body.
export class OpsTwoFactorRequiredException extends BitmonieException {
  constructor(context: { challenge_id: string }) {
    super(
      'OPS_2FA_REQUIRED',
      'Login requires a TOTP code. Submit the challenge_id with your TOTP code to /v1/ops/auth/verify-2fa.',
      HttpStatus.UNAUTHORIZED,
      [{ field: 'challenge_id', issue: context.challenge_id }],
    );
  }
}

// First-ever login after CLI provisioning. Carries the enrolment_token so
// the client can call /v1/ops/auth/enrol-2fa to set up TOTP server-side.
export class OpsTwoFactorEnrolmentRequiredException extends BitmonieException {
  constructor(context: { enrolment_token: string }) {
    super(
      'OPS_2FA_ENROLMENT_REQUIRED',
      'TOTP enrolment is required before a session can be issued. Submit the enrolment_token to /v1/ops/auth/enrol-2fa.',
      HttpStatus.FORBIDDEN,
      [{ field: 'enrolment_token', issue: context.enrolment_token }],
    );
  }
}

export class OpsTwoFactorInvalidException extends BitmonieException {
  constructor() {
    super(
      'OPS_2FA_INVALID',
      'TOTP code is invalid or the challenge has expired.',
      HttpStatus.UNAUTHORIZED,
    );
  }
}

export class OpsSessionInvalidException extends BitmonieException {
  constructor() {
    super(
      'OPS_SESSION_INVALID',
      'Ops session cookie is missing, expired, or revoked.',
      HttpStatus.UNAUTHORIZED,
    );
  }
}

export class OpsUserDisabledException extends BitmonieException {
  constructor() {
    super(
      'OPS_USER_DISABLED',
      'This ops account has been disabled.',
      HttpStatus.FORBIDDEN,
    );
  }
}

export class OpsTargetUserNotFoundException extends BitmonieException {
  constructor() {
    super(
      'OPS_TARGET_USER_NOT_FOUND',
      'Target user not found.',
      HttpStatus.NOT_FOUND,
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
