export const EMAIL_PROVIDER = 'EMAIL_PROVIDER';

export interface OtpEmailParams {
  to: string;
  otp: string;
  purpose: 'verify' | 'reset' | 'release_address_change';
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
