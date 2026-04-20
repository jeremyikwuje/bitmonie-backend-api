import type { QoreidConfig } from '@/config/providers.config';
import type { KycProvider, KycVerifyParams, KycVerifyResult } from '@/modules/kyc/kyc.provider.interface';
import {
  QoreidTokenResponseSchema,
  QoreidBvnResponseSchema,
  QoreidNinResponseSchema,
  QoreidPassportResponseSchema,
  QoreidDriversLicenseResponseSchema,
} from './qoreid.types';

function buildName(...parts: (string | undefined)[]): string {
  return parts.filter(Boolean).join(' ').trim();
}

export class QoreidProvider implements KycProvider {
  private access_token: string | null = null;
  private token_expires_at = 0;

  constructor(private readonly config: QoreidConfig) {}

  private async getAccessToken(): Promise<string> {
    if (this.access_token && Date.now() < this.token_expires_at - 60_000) {
      return this.access_token;
    }

    const res = await fetch(`${this.config.base_url}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: this.config.client_id,
        secret: this.config.client_secret,
      }),
    });

    if (!res.ok) {
      throw new Error(`Qoreid auth failed: ${res.status}`);
    }

    const data = QoreidTokenResponseSchema.parse(await res.json());
    this.access_token = data.accessToken;
    this.token_expires_at = Date.now() + data.expiresIn * 1_000;
    return this.access_token;
  }

  private async post<T>(
    path: string,
    body: Record<string, string>,
    schema: { parse: (v: unknown) => T },
  ): Promise<T> {
    const token = await this.getAccessToken();
    const res = await fetch(`${this.config.base_url}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Qoreid ${path} failed (${res.status}): ${text}`);
    }

    return schema.parse(await res.json());
  }

  async verifyBvn(params: KycVerifyParams): Promise<KycVerifyResult> {
    const data = await this.post(
      `/v1/ng/identities/bvn-premium/${params.id_number}`,
      { firstname: params.first_name, lastname: params.last_name, dob: params.date_of_birth },
      QoreidBvnResponseSchema,
    );
    const d = data.bvn;
    return {
      legal_name: buildName(d.firstname, d.middlename, d.lastname),
      provider_reference: d.bvn,
      date_of_birth: d.birthdate,
      raw_response: {
        firstname: d.firstname,
        lastname: d.lastname,
        middlename: d.middlename,
        birthdate: d.birthdate,
        gender: d.gender,
        marital_status: d.marital_status,
        nationality: d.nationality,
        state_of_origin: d.state_of_origin,
        state_of_residence: d.state_of_residence,
        enrollment_bank: d.enrollment_bank,
        watch_listed: d.watch_listed,
        name_on_card: d.name_on_card,
        level_of_account: d.level_of_account,
        insight: data.insight,
      },
    };
  }

  async verifyNin(params: KycVerifyParams): Promise<KycVerifyResult> {
    const data = await this.post(
      `/v1/ng/identities/nin/${params.id_number}`,
      { firstname: params.first_name, lastname: params.last_name, dob: params.date_of_birth },
      QoreidNinResponseSchema,
    );
    return {
      legal_name: buildName(data.firstname, data.middlename, data.lastname),
      provider_reference: data.nin,
      date_of_birth: data.birthdate,
      raw_response: {
        firstname: data.firstname,
        lastname: data.lastname,
        middlename: data.middlename,
        birthdate: data.birthdate,
        gender: data.gender,
        marital_status: data.maritalStatus,
        employment_status: data.employmentStatus,
        birth_state: data.birthState,
        birth_country: data.birthCountry,
        nationality: data.nationality,
        lga_of_origin: data.lgaOfOrigin,
        state_of_origin: data.stateOfOrigin,
        insight: data.insight,
      },
    };
  }

  async verifyPassport(params: KycVerifyParams): Promise<KycVerifyResult> {
    const data = await this.post(
      `/v1/ng/identities/passport/${params.id_number}`,
      { firstname: params.first_name, lastname: params.last_name, dob: params.date_of_birth },
      QoreidPassportResponseSchema,
    );
    const d = data.passport;
    return {
      legal_name: buildName(d.firstname, d.middlename, d.lastname),
      provider_reference: d.passport_number,
      date_of_birth: d.birthdate,
      raw_response: {
        firstname: d.firstname,
        lastname: d.lastname,
        middlename: d.middlename,
        birthdate: d.birthdate,
        gender: d.gender,
        issued_date: d.issued_date,
        expiry_date: d.expiry_date,
        insight: data.insight,
      },
    };
  }

  async verifyDriversLicense(params: KycVerifyParams): Promise<KycVerifyResult> {
    const data = await this.post(
      `/v1/ng/identities/drivers-license/${params.id_number}`,
      { firstname: params.first_name, lastname: params.last_name, dob: params.date_of_birth },
      QoreidDriversLicenseResponseSchema,
    );
    const d = data.drivers_license;
    return {
      legal_name: buildName(d.firstname, d.lastname),
      provider_reference: d.driversLicense,
      date_of_birth: d.birthdate,
      raw_response: {
        firstname: d.firstname,
        lastname: d.lastname,
        birthdate: d.birthdate,
        gender: d.gender,
        state_of_issue: d.state_of_issue,
        issued_date: d.issued_date,
        expiry_date: d.expiry_date,
        insight: data.insight,
      },
    };
  }
}
