export const KYC_PROVIDER_T1 = 'KYC_PROVIDER_T1';
export const KYC_PROVIDER_T2 = 'KYC_PROVIDER_T2';
export const KYC_PROVIDER_T3 = 'KYC_PROVIDER_T3';

export interface KycVerifyParams {
  id_number: string;
  first_name: string;
  last_name: string;
  middle_name?: string;
  date_of_birth: string;  // YYYY-MM-DD — providers that need it (Qoreid) use it in the request body
}

export interface KycVerifyResult {
  legal_name: string;
  provider_reference: string;
  date_of_birth?: string;                    // raw from provider — service normalises before comparing
  raw_response: Record<string, unknown>;     // audit snapshot stored on KycVerification
}

export interface KycProvider {
  verifyBvn(params: KycVerifyParams): Promise<KycVerifyResult>;
  verifyNin(params: KycVerifyParams): Promise<KycVerifyResult>;
  verifyPassport(params: KycVerifyParams): Promise<KycVerifyResult>;
  verifyDriversLicense(params: KycVerifyParams): Promise<KycVerifyResult>;
}
