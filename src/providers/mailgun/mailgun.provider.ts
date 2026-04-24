import type {
  EmailProvider,
  OtpEmailParams,
  TransactionalEmailParams,
} from '@/modules/auth/email.provider.interface';
import type { MailgunConfig } from '@/config/providers.config';

export class MailgunProvider implements EmailProvider {
  private static readonly BASE_URLS = {
    us: 'https://api.mailgun.net',
    eu: 'https://api.eu.mailgun.net',
  };

  constructor(private readonly config: MailgunConfig) {}

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
    const base = MailgunProvider.BASE_URLS[this.config.region];
    const url = `${base}/v3/${this.config.domain}/messages`;
    const auth = Buffer.from(`api:${this.config.api_key}`).toString('base64');

    const body = new URLSearchParams({
      from: `${this.config.from_name} <${this.config.from_address}>`,
      to: params.to,
      subject: params.subject,
      text: params.text,
      html: params.html,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Mailgun error ${response.status}: ${detail}`);
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
