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

export class LoanNotActiveForDisbursementException extends BitmonieException {
  constructor(context: { status: string }) {
    super(
      'LOAN_NOT_ACTIVE_FOR_DISBURSEMENT',
      'Loan must be ACTIVE to create a new disbursement.',
      HttpStatus.CONFLICT,
      [{ field: 'status', issue: `Loan is ${context.status}` }],
    );
  }
}

export class LoanHasActiveDisbursementException extends BitmonieException {
  constructor(context: { disbursement_id: string; status: string }) {
    super(
      'LOAN_HAS_ACTIVE_DISBURSEMENT',
      'Loan already has a non-terminal disbursement. Cancel or wait for it to settle before creating a new one.',
      HttpStatus.CONFLICT,
      [
        { field: 'disbursement_id', issue: context.disbursement_id },
        { field: 'status',          issue: context.status },
      ],
    );
  }
}

// Restore-from-bad-liquidation guardrails. Both 409 because the request is
// well-formed but the target loan is in the wrong state for this remediation.
export class LoanNotLiquidatedException extends BitmonieException {
  constructor(context: { status: string }) {
    super(
      'LOAN_NOT_LIQUIDATED',
      'Only LIQUIDATED loans can be restored.',
      HttpStatus.CONFLICT,
      [{ field: 'status', issue: `Loan is ${context.status}` }],
    );
  }
}

export class LiquidationNotBadRateException extends BitmonieException {
  constructor(context: {
    liquidation_rate_actual: string | null;
    sat_ngn_rate_at_creation: string;
    sanity_floor:             string;
  }) {
    super(
      'LIQUIDATION_NOT_BAD_RATE',
      'Liquidation does not match the bad-rate signature; restoration refused.',
      HttpStatus.CONFLICT,
      [
        { field: 'liquidation_rate_actual',  issue: context.liquidation_rate_actual ?? 'null' },
        { field: 'sat_ngn_rate_at_creation', issue: context.sat_ngn_rate_at_creation },
        { field: 'sanity_floor',             issue: context.sanity_floor },
      ],
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

export class InflowNotFoundException extends BitmonieException {
  constructor() {
    super(
      'INFLOW_NOT_FOUND',
      'Inflow not found, or does not belong to you.',
      HttpStatus.NOT_FOUND,
    );
  }
}

export class InflowAlreadyMatchedException extends BitmonieException {
  constructor(context?: { matched_at?: string; source_id?: string }) {
    const details: BitmonieErrorDetail[] = [];
    if (context?.matched_at) details.push({ field: 'matched_at', issue: context.matched_at });
    if (context?.source_id)  details.push({ field: 'source_id',  issue: context.source_id });
    super(
      'INFLOW_ALREADY_MATCHED',
      'This inflow has already been applied to a loan.',
      HttpStatus.CONFLICT,
      details.length > 0 ? details : undefined,
    );
  }
}

export class CollateralAlreadyReleasedException extends BitmonieException {
  constructor(context: { released_at: string; reference?: string }) {
    const details: BitmonieErrorDetail[] = [
      { field: 'released_at', issue: context.released_at },
    ];
    if (context.reference) details.push({ field: 'reference', issue: context.reference });
    super(
      'COLLATERAL_ALREADY_RELEASED',
      'Collateral has already been released for this loan — release address can no longer be changed.',
      HttpStatus.CONFLICT,
      details,
    );
  }
}

export class ReleaseAddressAlreadySetException extends BitmonieException {
  constructor() {
    super(
      'RELEASE_ADDRESS_ALREADY_SET',
      'Release address has already been set for this loan and cannot be changed. Contact support if you entered the wrong address.',
      HttpStatus.CONFLICT,
    );
  }
}

export class ReleaseAddressOtpRequiredException extends BitmonieException {
  constructor() {
    super(
      'RELEASE_ADDRESS_OTP_REQUIRED',
      'Changing the release address requires email confirmation. Request an OTP first via POST /v1/loans/:id/release-address/request-change-otp.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class ReleaseAddressNotYetSetException extends BitmonieException {
  constructor() {
    super(
      'RELEASE_ADDRESS_NOT_YET_SET',
      'No release address is set on this loan yet — submit it directly via PATCH /v1/loans/:id/release-address. The OTP step is only required when changing an existing address.',
      HttpStatus.CONFLICT,
    );
  }
}

export class CollateralReleaseNotEligibleException extends BitmonieException {
  constructor(reason: string) {
    super(
      'COLLATERAL_RELEASE_NOT_ELIGIBLE',
      'Loan is not eligible for collateral release.',
      HttpStatus.CONFLICT,
      [{ field: 'reason', issue: reason }],
    );
  }
}

export class CollateralReleaseSendFailedException extends BitmonieException {
  constructor(error: string) {
    super(
      'COLLATERAL_RELEASE_SEND_FAILED',
      'Collateral release attempted but the provider rejected the send. Loan was not stamped — safe to retry after fixing the cause.',
      HttpStatus.BAD_GATEWAY,
      [{ field: 'error', issue: error }],
    );
  }
}

export class RepaymentAccountNotReadyException extends BitmonieException {
  constructor() {
    super(
      'REPAYMENT_ACCOUNT_NOT_READY',
      'Your repayment account is not yet provisioned. Please contact support.',
      HttpStatus.UNPROCESSABLE_ENTITY,
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

export class DisbursementAccountDuplicateException extends BitmonieException {
  constructor() {
    super(
      'DISBURSEMENT_ACCOUNT_DUPLICATE',
      'You have already linked this account.',
      HttpStatus.CONFLICT,
      [{ field: 'account_unique', issue: 'An account with the same provider_code and account_unique already exists for this kind' }],
    );
  }
}

export class DisbursementAccountLookupFailedException extends BitmonieException {
  constructor() {
    super(
      'DISBURSEMENT_ACCOUNT_LOOKUP_FAILED',
      'We could not verify this account with your bank. Check the bank and account number and try again.',
      HttpStatus.UNPROCESSABLE_ENTITY,
      [{ field: 'account_unique', issue: 'Provider returned no account holder for this bank/account combination' }],
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

// Generic "rejected" credential. Customer auth is passwordless, so this is
// raised for: wrong login OTP (we surface `AUTH_OTP_EXPIRED` for TTL/empty,
// but a code mismatch routes here too via timing-safe compare); a TOTP code
// rejected during a 2FA-gated step-up; a transaction-PIN check routed here
// when the dedicated `TransactionPinInvalidException` would leak intent.
export class AuthInvalidCredentialsException extends BitmonieException {
  constructor() {
    super(
      'AUTH_INVALID_CREDENTIALS',
      'Invalid credentials.',
      HttpStatus.UNAUTHORIZED,
    );
  }
}

export class AuthOtpExpiredException extends BitmonieException {
  constructor() {
    super(
      'AUTH_OTP_EXPIRED',
      'OTP has expired or is invalid. Please request a new one.',
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

// Raised when an authenticated step (e.g. disabling 2FA) requires the user
// to prove possession of their TOTP authenticator and either no code was
// submitted or the user has not enrolled. NOT raised at login — login is
// passwordless and never asks for TOTP.
export class Auth2faRequiredException extends BitmonieException {
  constructor() {
    super(
      'AUTH_2FA_REQUIRED',
      'A TOTP code is required for this action.',
      HttpStatus.UNAUTHORIZED,
    );
  }
}

// ── TRANSACTION PIN ─────────────────────────────────────────────

export class TransactionPinNotSetException extends BitmonieException {
  constructor() {
    super(
      'TRANSACTION_PIN_NOT_SET',
      'Transaction PIN is not set. Set one via POST /v1/auth/transaction-pin/set first.',
      HttpStatus.CONFLICT,
    );
  }
}

export class TransactionPinAlreadySetException extends BitmonieException {
  constructor() {
    super(
      'TRANSACTION_PIN_ALREADY_SET',
      'Transaction PIN is already set. Use POST /v1/auth/transaction-pin/change to change it.',
      HttpStatus.CONFLICT,
    );
  }
}

export class TransactionPinInvalidException extends BitmonieException {
  constructor() {
    super(
      'TRANSACTION_PIN_INVALID',
      'Transaction PIN is incorrect.',
      HttpStatus.UNAUTHORIZED,
    );
  }
}

export class TransactionPinLockedException extends BitmonieException {
  constructor(context: { unlocks_at: string }) {
    super(
      'TRANSACTION_PIN_LOCKED',
      'Transaction PIN is locked due to too many wrong attempts. Try again after the lockout window.',
      HttpStatus.TOO_MANY_REQUESTS,
      [{ field: 'unlocks_at', issue: context.unlocks_at }],
    );
  }
}

// ── STEP-UP (transaction factor: PIN OR TOTP) ───────────────────

// User submitted a sensitive request that requires a step-up factor but
// did not provide one (or provided neither pin nor totp_code).
export class TransactionFactorRequiredException extends BitmonieException {
  constructor() {
    super(
      'TRANSACTION_FACTOR_REQUIRED',
      'This action requires a transaction PIN or TOTP code. Submit one of `transaction_pin` or `totp_code`.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

// Hard prerequisite for sensitive ops (e.g. changing the release address):
// the user must have at least one of {transaction PIN, TOTP} configured.
// If both are unset, refuse — there is no factor to step up against.
export class TransactionFactorNotSetException extends BitmonieException {
  constructor() {
    super(
      'TRANSACTION_FACTOR_NOT_SET',
      'Set a transaction PIN or enable 2FA before performing this action.',
      HttpStatus.UNPROCESSABLE_ENTITY,
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
