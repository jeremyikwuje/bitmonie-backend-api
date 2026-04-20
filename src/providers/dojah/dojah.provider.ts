import type { DojahConfig } from '@/config/providers.config';
import type { KycProvider, KycVerifyParams, KycVerifyResult } from '@/modules/kyc/kyc.provider.interface';
import {
  DojahBvnResponseSchema,
  DojahNinResponseSchema,
  DojahPassportResponseSchema,
  DojahDriversLicenseResponseSchema,
} from './dojah.types';

const BASE_URL = 'https://api.dojah.io/api/v1';

function buildName(...parts: (string | undefined)[]): string {
  return parts.filter(Boolean).join(' ').trim();
}

export class DojahProvider implements KycProvider {
  constructor(private readonly config: DojahConfig) {}

  private async get<T>(path: string, schema: { parse: (v: unknown) => T }): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: {
        'AppId': this.config.app_id,
        'Authorization': this.config.api_key,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Dojah ${path} failed (${res.status}): ${body}`);
    }

    return schema.parse(await res.json());
  }

  async verifyBvn(params: KycVerifyParams): Promise<KycVerifyResult> {
    const data = await this.get(`/kyc/bvn/full?bvn=${params.id_number}`, DojahBvnResponseSchema);
    const e = data.entity;
    const legal_name = e.full_name ?? buildName(e.first_name, e.middle_name, e.last_name);
    return {
      legal_name,
      provider_reference: e.bvn,
      date_of_birth: e.date_of_birth,
      raw_response: {
        first_name: e.first_name,
        last_name: e.last_name,
        middle_name: e.middle_name,
        date_of_birth: e.date_of_birth,
        gender: e.gender,
        phone_number1: e.phone_number1,
        phone_number2: e.phone_number2,
      },
    };
  }

  async verifyNin(params: KycVerifyParams): Promise<KycVerifyResult> {
    const data = await this.get(`/kyc/nin?nin=${params.id_number}`, DojahNinResponseSchema);
    const e = data.entity;
    const legal_name = e.full_name ?? buildName(e.first_name, e.middle_name, e.last_name);
    return {
      legal_name,
      provider_reference: e.nin,
      date_of_birth: e.date_of_birth,
      raw_response: {
        first_name: e.first_name,
        last_name: e.last_name,
        middle_name: e.middle_name,
        date_of_birth: e.date_of_birth,
        gender: e.gender,
        phone_number: e.phone_number,
        employment_status: e.employment_status,
        marital_status: e.marital_status,
      },
    };
  }

  async verifyPassport(params: KycVerifyParams): Promise<KycVerifyResult> {
    const data = await this.get(
      `/kyc/passport?passport_number=${params.id_number}`,
      DojahPassportResponseSchema,
    );
    const e = data.entity;
    const legal_name = e.full_name ?? buildName(e.first_name, e.middle_name, e.last_name);
    return {
      legal_name,
      provider_reference: e.passport_number,
      date_of_birth: e.date_of_birth,
      raw_response: {
        first_name: e.first_name,
        last_name: e.last_name,
        middle_name: e.middle_name,
        date_of_birth: e.date_of_birth,
        gender: e.gender,
        issued_date: e.issued_date,
        expiry_date: e.expiry_date,
      },
    };
  }

  async verifyDriversLicense(params: KycVerifyParams): Promise<KycVerifyResult> {
    const data = await this.get(
      `/kyc/dl?license_number=${params.id_number}`,
      DojahDriversLicenseResponseSchema,
    );
    const e = data.entity;
    const legal_name = e.full_name ?? buildName(e.first_name, e.middle_name, e.last_name);
    return {
      legal_name,
      provider_reference: e.license_number,
      date_of_birth: e.date_of_birth,
      raw_response: {
        first_name: e.first_name,
        last_name: e.last_name,
        middle_name: e.middle_name,
        date_of_birth: e.date_of_birth,
        gender: e.gender,
        expiry_date: e.expiry_date,
        state_of_issue: e.state_of_issue,
      },
    };
  }
}
