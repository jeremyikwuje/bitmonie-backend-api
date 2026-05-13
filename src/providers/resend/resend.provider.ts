import type {
  EmailProvider,
  OtpEmailParams,
  TransactionalEmailParams,
} from '@/modules/auth/email.provider.interface';
import { buildOtpEmailContent } from '@/modules/auth/otp-email-content';
import type { ResendConfig } from '@/config/providers.config';

export class ResendProvider implements EmailProvider {
  private static readonly BASE_URL = 'https://api.resend.com';

  constructor(private readonly config: ResendConfig) {}

  async sendOtp(params: OtpEmailParams): Promise<void> {
    const { subject, text, html } = buildOtpEmailContent(params);
    return this._send({ to: params.to, subject, text, html });
  }

  async sendTransactional(params: TransactionalEmailParams): Promise<void> {
    return this._send({
      to:       params.to,
      subject:  params.subject,
      text:     params.text_body,
      html:     params.html_body,
      reply_to: params.reply_to,
    });
  }

  private async _send(params: {
    to: string;
    subject: string;
    text: string;
    html: string;
    reply_to?: string;
  }): Promise<void> {
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
        ...(params.reply_to ? { reply_to: params.reply_to } : {}),
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Resend error ${response.status}: ${detail}`);
    }
  }
}
