export const EMAIL_PROVIDER = 'EMAIL_PROVIDER';

export type OtpPurpose =
  // Email verification at signup, and resend-verification for unverified users.
  | 'verify'
  // Passwordless login — proves possession of the email account before
  // minting a session.
  | 'login'
  // Step-up before changing the collateral release address on a loan.
  | 'release_address_change'
  // Step-up before setting a transaction PIN for the first time.
  | 'transaction_pin_set'
  // Step-up before changing an existing transaction PIN.
  | 'transaction_pin_change'
  // Step-up before disabling an existing transaction PIN.
  | 'transaction_pin_disable';

export interface OtpEmailParams {
  to: string;
  otp: string;
  purpose: OtpPurpose;
}

// Pre-rendered transactional email. Caller composes subject + body strings;
// providers send them as-is. Used for ops alerts (unmatched inflows, payout
// failures, etc.) and customer notifications (loan reminders) — anywhere we
// need an email path that isn't OTP. v1.2 will move template composition into
// provider-native systems (Mailgun Templates, Postmark TemplateAlias, etc.).
export interface TransactionalEmailParams {
  to:        string;
  subject:   string;
  text_body: string;
  html_body: string;
}

export interface EmailProvider {
  sendOtp(params: OtpEmailParams): Promise<void>;
  sendTransactional(params: TransactionalEmailParams): Promise<void>;
}
