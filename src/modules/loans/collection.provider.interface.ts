// Collection provider — creates NGN virtual accounts for inbound customer payments.
// Owned by the loans domain since loan repayment is the primary use case.
export interface CollectionProvider {
  createVirtualAccount(params: {
    virtual_account_name: string;
    identity_type: string;     // 'BVN' | 'NIN'
    license_number: string;    // decrypted BVN/NIN — never log this value
    customer_name: string;
    account_reference: string; // our reference (e.g. loan_id) — returned in webhook
  }): Promise<{
    virtual_account_no: string;
    virtual_account_name: string;
  }>;
}
