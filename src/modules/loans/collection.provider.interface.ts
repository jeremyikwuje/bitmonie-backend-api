// Collection provider — creates NGN virtual accounts for inbound customer payments.
// Owned by the loans domain since loan repayment is the primary use case.

// Identity types that can back a customer NGN virtual account.
// Restricted to tier-1 KYC document types currently supported by the
// collection rail; PASSPORT/DRIVERS_LICENSE entries cannot back a VA.
// Each provider is responsible for translating to its own wire format.
export type CollectionIdentityType = 'BVN' | 'NIN';

export interface CollectionProvider {
  createVirtualAccount(params: {
    virtual_account_name: string;
    identity_type: CollectionIdentityType;
    license_number: string;    // decrypted BVN/NIN — never log this value
    customer_name: string;
    account_reference: string; // our reference (e.g. loan_id) — returned in webhook
  }): Promise<{
    virtual_account_no: string;
    virtual_account_name: string;
  }>;
}
