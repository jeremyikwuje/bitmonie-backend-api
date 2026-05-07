// Shared OTP email content. Each EmailProvider maps the {subject, text, html}
// triple to its own SDK shape — Postmark uses {Subject, TextBody, HtmlBody},
// Mailgun uses {subject, text, html}, etc. Keeping content here eliminates
// drift across providers when a new purpose is added.

import type { OtpEmailParams } from './email.provider.interface';

export interface OtpEmailContent {
  subject: string;
  text:    string;
  html:    string;
}

const EXPIRY_NOTICE = 'This code expires in 15 minutes.';

export function buildOtpEmailContent(params: OtpEmailParams): OtpEmailContent {
  switch (params.purpose) {
    case 'verify':
      return {
        subject: 'Verify your Bitmonie account',
        text:    `Your Bitmonie verification code is: ${params.otp}\n\n${EXPIRY_NOTICE} Do not share it with anyone.`,
        html:    `<p>Your Bitmonie verification code is:</p><h2>${params.otp}</h2><p>${EXPIRY_NOTICE} Do not share it with anyone.</p>`,
      };
    case 'login':
      return {
        subject: 'Your Bitmonie login code',
        text:
          `Your Bitmonie login code is: ${params.otp}\n\n` +
          `${EXPIRY_NOTICE}\n\n` +
          `If you did not try to log in, ignore this email and consider enabling 2FA in Settings.`,
        html:
          `<p>Your Bitmonie login code is:</p><h2>${params.otp}</h2>` +
          `<p>${EXPIRY_NOTICE}</p>` +
          `<p>If you did not try to log in, ignore this email and consider enabling 2FA in Settings.</p>`,
      };
    case 'release_address_change':
      return {
        subject: 'Confirm your Bitmonie collateral-release address change',
        text:
          `Someone — hopefully you — requested to change the Lightning address that will receive your collateral SAT after this loan is repaid.\n\n` +
          `Your confirmation code is: ${params.otp}\n\n` +
          `${EXPIRY_NOTICE}\n\n` +
          `If this wasn't you, do NOT share this code. Contact support immediately at support@bitmonie.com — your account may be compromised.`,
        html:
          `<p>Someone — hopefully you — requested to change the Lightning address that will receive your collateral SAT after this loan is repaid.</p>` +
          `<p>Your confirmation code is:</p><h2>${params.otp}</h2>` +
          `<p>${EXPIRY_NOTICE}</p>` +
          `<p><b>If this wasn't you</b>, do not share this code. Contact <a href="mailto:support@bitmonie.com">support@bitmonie.com</a> immediately — your account may be compromised.</p>`,
      };
    case 'transaction_pin_set':
      return {
        subject: 'Set your Bitmonie transaction PIN',
        text:
          `Your transaction-PIN setup code is: ${params.otp}\n\n` +
          `${EXPIRY_NOTICE}\n\n` +
          `If you did not request to set a transaction PIN, contact support immediately at support@bitmonie.com.`,
        html:
          `<p>Your transaction-PIN setup code is:</p><h2>${params.otp}</h2>` +
          `<p>${EXPIRY_NOTICE}</p>` +
          `<p><b>If you did not request this</b>, contact <a href="mailto:support@bitmonie.com">support@bitmonie.com</a> immediately.</p>`,
      };
    case 'transaction_pin_change':
      return {
        subject: 'Confirm your Bitmonie transaction-PIN change',
        text:
          `Someone — hopefully you — requested to change your Bitmonie transaction PIN.\n\n` +
          `Your confirmation code is: ${params.otp}\n\n` +
          `${EXPIRY_NOTICE}\n\n` +
          `If this wasn't you, do NOT share this code. Contact support immediately at support@bitmonie.com — your account may be compromised.`,
        html:
          `<p>Someone — hopefully you — requested to change your Bitmonie transaction PIN.</p>` +
          `<p>Your confirmation code is:</p><h2>${params.otp}</h2>` +
          `<p>${EXPIRY_NOTICE}</p>` +
          `<p><b>If this wasn't you</b>, do not share this code. Contact <a href="mailto:support@bitmonie.com">support@bitmonie.com</a> immediately — your account may be compromised.</p>`,
      };
    case 'transaction_pin_disable':
      return {
        subject: 'Confirm disabling your Bitmonie transaction PIN',
        text:
          `Someone — hopefully you — requested to DISABLE your Bitmonie transaction PIN.\n\n` +
          `Your confirmation code is: ${params.otp}\n\n` +
          `${EXPIRY_NOTICE}\n\n` +
          `Disabling your PIN removes a layer of protection. If this wasn't you, do NOT share this code. Contact support immediately at support@bitmonie.com.`,
        html:
          `<p>Someone — hopefully you — requested to <b>disable</b> your Bitmonie transaction PIN.</p>` +
          `<p>Your confirmation code is:</p><h2>${params.otp}</h2>` +
          `<p>${EXPIRY_NOTICE}</p>` +
          `<p>Disabling your PIN removes a layer of protection. <b>If this wasn't you</b>, do not share this code. Contact <a href="mailto:support@bitmonie.com">support@bitmonie.com</a> immediately.</p>`,
      };
  }
}
