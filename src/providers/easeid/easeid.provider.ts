import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import * as forge from 'node-forge';
import type { EaseidConfig } from '@/config/providers.config';
import type { KycProvider, KycVerifyParams, KycVerifyResult } from '@/modules/kyc/kyc.provider.interface';
import {
  EaseidBvnResponseSchema,
  EaseidNinResponseSchema,
  EASEID_RESP_CODE_SUCCESS,
} from './easeid.types';

const BASE_URL = 'https://open-api.easeid.ai';

function nonce_str(): string {
  return crypto.randomBytes(16).toString('hex');
}

function buildName(...parts: (string | undefined)[]): string {
  return parts.filter(Boolean).join(' ').trim();
}

// Accept either a full PEM (with BEGIN/END headers) or the bare base64 body
// EaseID's portal hands out. Dotenv preserves literal `\n` so we expand those
// first, then wrap as PKCS#8 if no header is present. 64-char line breaks
// are required for a valid PEM body.
function normalize_pem(raw: string): string {
  const expanded = raw.replace(/\\n/g, '\n').trim();
  if (expanded.includes('-----BEGIN')) return expanded;

  const base64 = expanded.replace(/\s+/g, '');
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 64) {
    lines.push(base64.slice(i, i + 64));
  }
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`;
}

@Injectable()
export class EaseidProvider implements KycProvider {
  private readonly logger = new Logger(EaseidProvider.name);
  private readonly private_key_pem: string;

  constructor(private readonly config: EaseidConfig) {
    this.private_key_pem = normalize_pem(config.private_key);
  }

  // ── Signing ────────────────────────────────────────────────────────────────

  // EaseID signing protocol (mirrors PalmPay — same MD5/SHA1WithRSA scheme):
  //   1. Sort all params (excluding nulls/empty), concat as key=value&…
  //   2. MD5-hash the result (uppercase hex)
  //   3. RSA-SHA1 sign the MD5 string with merchant private key
  //   4. Base64-encode the signature → goes in the `Signature` request header
  private build_signature(params: Record<string, unknown>): string {
    const sorted = Object.keys(params)
      .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
      .sort()
      .map((k) => `${k}=${String(params[k])}`)
      .join('&');

    const md5 = crypto.createHash('md5').update(sorted, 'utf8').digest('hex').toUpperCase();

    const private_key = forge.pki.privateKeyFromPem(this.private_key_pem);
    const md = forge.md.sha1.create();
    md.update(md5, 'utf8');
    const signature = private_key.sign(md);
    return Buffer.from(signature, 'binary').toString('base64');
  }

  // ── HTTP ───────────────────────────────────────────────────────────────────

  private async post<T>(
    path: string,
    body: Record<string, unknown>,
    schema: { parse: (v: unknown) => T },
  ): Promise<T> {
    // Per EaseID docs, only requestTime/version/nonceStr are part of the
    // common request body; appId travels in the Authorization header. The
    // balance endpoint additionally repeats appId in the body — we let the
    // caller pass that explicitly via `body` rather than injecting it here.
    const payload: Record<string, unknown> = {
      ...body,
      requestTime: Date.now(),
      version: 'V1.1',
      nonceStr: nonce_str(),
    };

    const signature = this.build_signature(payload);

    const response = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'CountryCode': 'NG',
        'Authorization': `Bearer ${this.config.app_id}`,
        'Signature': signature,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      this.logger.error(
        { path, status: response.status, body: text },
        'EaseID HTTP error',
      );
      throw new Error(`EaseID ${path} HTTP ${response.status}: ${text}`);
    }

    const json: unknown = await response.json();
    return schema.parse(json);
  }

  // ── verifyBvn (Enhanced BVN Enquiry) ──────────────────────────────────────

  async verifyBvn(params: KycVerifyParams): Promise<KycVerifyResult> {
    const data = await this.post(
      '/api/validator-service/open/bvn/inquire',
      { bvn: params.id_number },
      EaseidBvnResponseSchema,
    );

    if (data.respCode !== EASEID_RESP_CODE_SUCCESS) {
      this.logger.error(
        { resp_code: data.respCode, resp_msg: data.respMsg, request_id: data.requestId },
        'EaseID bvn inquire failed',
      );
      throw new Error(`EaseID bvn inquire failed: ${data.respCode} ${data.respMsg}`);
    }
    const e = data.data;
    if (!e) throw new Error('EaseID bvn inquire returned no data');

    return {
      legal_name: buildName(e.firstName, e.middleName, e.lastName),
      provider_reference: e.bvn,
      date_of_birth: e.birthday,
      raw_response: {
        first_name: e.firstName,
        middle_name: e.middleName,
        last_name: e.lastName,
        birthday: e.birthday,
        gender: e.gender,
        name_on_card: e.nameOnCard,
        marital_status: e.maritalStatus,
        nationality: e.nationality,
        state_of_origin: e.stateOfOrigin,
        lga_of_origin: e.lgaOfOrigin,
        state_of_residence: e.stateOfResidence,
        lga_of_residence: e.lgaOfResidence,
        residential_address: e.residentialAddress,
        registration_date: e.registrationDate,
        enrollment_bank: e.enrollmentBank,
        enrollment_branch: e.enrollmentBranch,
        watch_listed: e.watchListed,
        level_of_account: e.levelOfAccount,
        request_id: data.requestId,
      },
    };
  }

  // ── verifyNin (Enhanced NIN Enquiry) ──────────────────────────────────────

  async verifyNin(params: KycVerifyParams): Promise<KycVerifyResult> {
    const data = await this.post(
      '/api/validator-service/open/nin/inquire',
      { nin: params.id_number },
      EaseidNinResponseSchema,
    );

    if (data.respCode !== EASEID_RESP_CODE_SUCCESS) {
      this.logger.error(
        { resp_code: data.respCode, resp_msg: data.respMsg, request_id: data.requestId },
        'EaseID nin inquire failed',
      );
      throw new Error(`EaseID nin inquire failed: ${data.respCode} ${data.respMsg}`);
    }
    const e = data.data;
    if (!e) throw new Error('EaseID nin inquire returned no data');

    return {
      legal_name: buildName(e.firstName, e.middleName, e.surname),
      provider_reference: e.nin,
      date_of_birth: e.birthDate,
      raw_response: {
        first_name: e.firstName,
        middle_name: e.middleName,
        surname: e.surname,
        birth_date: e.birthDate,
        gender: e.gender,
        telephone_no: e.telephoneNo,
        request_id: data.requestId,
      },
    };
  }

  // EaseID does not currently expose passport or voters card endpoints.
  // Throwing keeps the KycProvider contract intact; the kyc service should
  // never route these tiers to EaseID until the endpoints are available.
  async verifyPassport(_params: KycVerifyParams): Promise<KycVerifyResult> {
    throw new Error('EaseID does not support passport verification');
  }

  async verifyDriversLicense(_params: KycVerifyParams): Promise<KycVerifyResult> {
    throw new Error('EaseID does not support drivers license verification');
  }
}
