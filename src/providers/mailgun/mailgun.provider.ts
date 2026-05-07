import type {
  EmailProvider,
  OtpEmailParams,
  TransactionalEmailParams,
} from '@/modules/auth/email.provider.interface';
import { buildOtpEmailContent } from '@/modules/auth/otp-email-content';
import type { MailgunConfig } from '@/config/providers.config';

export class MailgunProvider implements EmailProvider {
  private static readonly BASE_URLS = {
    us: 'https://api.mailgun.net',
    eu: 'https://api.eu.mailgun.net',
  };

  constructor(private readonly config: MailgunConfig) {}

  async sendOtp(params: OtpEmailParams): Promise<void> {
    const { subject, text, html } = buildOtpEmailContent(params);
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

