import type { KycProvider, KycVerifyParams, KycVerifyResult } from '@/modules/kyc/kyc.provider.interface';

const STUB_NAME = 'Stub Test User';
const STUB_DOB  = '1990-01-01';

const STUB_RAW: Record<string, unknown> = { source: 'stub', note: 'local development only' };

export class StubKycProvider implements KycProvider {
  async verifyBvn(params: KycVerifyParams): Promise<KycVerifyResult> {
    return { legal_name: STUB_NAME, provider_reference: params.id_number, date_of_birth: STUB_DOB, raw_response: STUB_RAW };
  }
  async verifyNin(params: KycVerifyParams): Promise<KycVerifyResult> {
    return { legal_name: STUB_NAME, provider_reference: params.id_number, date_of_birth: STUB_DOB, raw_response: STUB_RAW };
  }
  async verifyPassport(params: KycVerifyParams): Promise<KycVerifyResult> {
    return { legal_name: STUB_NAME, provider_reference: params.id_number, date_of_birth: STUB_DOB, raw_response: STUB_RAW };
  }
  async verifyDriversLicense(params: KycVerifyParams): Promise<KycVerifyResult> {
    return { legal_name: STUB_NAME, provider_reference: params.id_number, date_of_birth: STUB_DOB, raw_response: STUB_RAW };
  }
}
