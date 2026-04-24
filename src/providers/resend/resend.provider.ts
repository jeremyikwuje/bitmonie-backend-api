import type {
  EmailProvider,
  OtpEmailParams,
  TransactionalEmailParams,
} from '@/modules/auth/email.provider.interface';
import type { ResendConfig } from '@/config/providers.config';

export class ResendProvider implements EmailProvider {
  private static readonly BASE_URL = 'https://api.resend.com';

  constructor(private readonly config: ResendConfig) {}

  async sendOtp(params: OtpEmailParams): Promise<void> {
    const { subject, text, html } = buildOtpEmail(params);
    return this._send({ to: params.to, subject, text, html });
  }

  async sendTransactional(params: TransactionalEmailParams): Promise<void> {
    return this._send({
      to:      params.to,
      subject: params.subject,
      text:    params.text_body,
      html:    params.html_body,
    });
  }

  private async _send(params: { to: string; subject: string; text: string; html: string }): Promise<void> {
    const response = await fetch(`${ResendProvider.BASE_URL}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.api_key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${this.config.from_name} <${this.config.from_address}>`,
        to: [params.to],
        subject: params.subject,
        text:    params.text,
        html:    params.html,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Resend error ${response.status}: ${detail}`);
    }
  }
}

function buildOtpEmail(params: OtpEmailParams): { subject: string; text: string; html: string } {
  if (params.purpose === 'verify') {
    return {
      subject: 'Verify your Bitmonie account',
      text: `Your Bitmonie verification code is: ${params.otp}\n\nThis code expires in 15 minutes. Do not share it with anyone.`,
      html: `<p>Your Bitmonie verification code is:</p><h2>${params.otp}</h2><p>This code expires in 15 minutes. Do not share it with anyone.</p>`,
    };
  }
  return {
    subject: 'Reset your Bitmonie password',
    text: `Your Bitmonie password reset code is: ${params.otp}\n\nThis code expires in 15 minutes. If you did not request this, ignore this email.`,
    html: `<p>Your Bitmonie password reset code is:</p><h2>${params.otp}</h2><p>This code expires in 15 minutes. If you did not request this, ignore this email.</p>`,
  };
}
