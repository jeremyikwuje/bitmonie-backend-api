export const EMAIL_PROVIDER = 'EMAIL_PROVIDER';

export interface OtpEmailParams {
  to: string;
  otp: string;
  purpose: 'verify' | 'reset';
}

export interface EmailProvider {
  sendOtp(params: OtpEmailParams): Promise<void>;
}
