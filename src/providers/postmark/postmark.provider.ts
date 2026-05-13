import type {
  EmailProvider,
  OtpEmailParams,
  TransactionalEmailParams,
} from '@/modules/auth/email.provider.interface';
import { buildOtpEmailContent } from '@/modules/auth/otp-email-content';
import type { PostmarkConfig } from '@/config/providers.config';

export class PostmarkProvider implements EmailProvider {
  private static readonly BASE_URL = 'https://api.postmarkapp.com';

  constructor(private readonly config: PostmarkConfig) {}

  async sendOtp(params: OtpEmailParams): Promise<void> {
    const { subject, text, html } = buildOtpEmailContent(params);
    return this._send({ to: params.to, subject, text_body: text, html_body: html });
  }

  async sendTransactional(params: TransactionalEmailParams): Promise<void> {
    return this._send(params);
  }

  private async _send(params: TransactionalEmailParams): Promise<void> {
    const response = await fetch(`${PostmarkProvider.BASE_URL}/email`, {
      method: 'POST',
      headers: {
        'X-Postmark-Server-Token': this.config.server_token,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        From: `${this.config.from_name} <${this.config.from_address}>`,
        To: params.to,
        Subject: params.subject,
        TextBody: params.text_body,
        HtmlBody: params.html_body,
        MessageStream: this.config.message_stream ?? 'outbound',
        ...(params.reply_to ? { ReplyTo: params.reply_to } : {}),
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Postmark error ${response.status}: ${detail}`);
    }
  }
}

