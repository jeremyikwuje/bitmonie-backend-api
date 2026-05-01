import type {
  EmailProvider,
  OtpEmailParams,
  TransactionalEmailParams,
} from '@/modules/auth/email.provider.interface';
import type { PostmarkConfig } from '@/config/providers.config';

export class PostmarkProvider implements EmailProvider {
  private static readonly BASE_URL = 'https://api.postmarkapp.com';

  constructor(private readonly config: PostmarkConfig) {}

  async sendOtp(params: OtpEmailParams): Promise<void> {
    const { subject, text_body, html_body } = buildOtpEmail(params);
    return this._send({ to: params.to, subject, text_body, html_body });
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
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Postmark error ${response.status}: ${detail}`);
    }
  }
}

function buildOtpEmail(params: OtpEmailParams): { subject: string; text_body: string; html_body: string } {
  switch (params.purpose) {
    case 'verify':
      return {
        subject: 'Verify your Bitmonie account',
        text_body: `Your Bitmonie verification code is: ${params.otp}\n\nThis code expires in 15 minutes. Do not share it with anyone.`,
        html_body: `<p>Your Bitmonie verification code is:</p><h2>${params.otp}</h2><p>This code expires in 15 minutes. Do not share it with anyone.</p>`,
      };
    case 'reset':
      return {
        subject: 'Reset your Bitmonie password',
        text_body: `Your Bitmonie password reset code is: ${params.otp}\n\nThis code expires in 15 minutes. If you did not request this, ignore this email.`,
        html_body: `<p>Your Bitmonie password reset code is:</p><h2>${params.otp}</h2><p>This code expires in 15 minutes. If you did not request this, ignore this email.</p>`,
      };
    case 'release_address_change':
      return {
        subject: 'Confirm your Bitmonie collateral-release address change',
        text_body:
          `Someone — hopefully you — requested to change the Lightning address that will receive your collateral SAT after this loan is repaid.\n\n` +
          `Your confirmation code is: ${params.otp}\n\n` +
          `This code expires in 15 minutes.\n\n` +
          `If this wasn't you, do NOT share this code. Contact support immediately at support@bitmonie.com — your account may be compromised.`,
        html_body:
          `<p>Someone — hopefully you — requested to change the Lightning address that will receive your collateral SAT after this loan is repaid.</p>` +
          `<p>Your confirmation code is:</p><h2>${params.otp}</h2>` +
          `<p>This code expires in 15 minutes.</p>` +
          `<p><b>If this wasn't you</b>, do not share this code. Contact <a href="mailto:support@bitmonie.com">support@bitmonie.com</a> immediately — your account may be compromised.</p>`,
      };
  }
}
