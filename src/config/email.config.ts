export enum EmailProviderName {
  Mailgun = 'mailgun',
  Resend = 'resend',
  Postmark = 'postmark',
}

export const EMAIL_PROVIDER_CONFIG: EmailProviderName = EmailProviderName.Mailgun;
