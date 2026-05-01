// Standardised `action` values for OpsAuditLog.
// Add new ones here BEFORE using — the audit log is append-only and search
// across actions only stays useful if vocabulary stays small + canonical.
// Mirror of LoanReasonCodes for ops actions.
export const OPS_ACTION = {
  KYC_RESET:            'kyc.reset',
  KYC_REVOKE:           'kyc.revoke',
  KYC_PROVISION_VA:     'kyc.provision_va',
  DISBURSEMENT_RETRY:           'disbursement.retry',
  DISBURSEMENT_CANCEL:          'disbursement.cancel',
  DISBURSEMENT_ABANDON_ATTEMPT: 'disbursement.abandon_attempt',
  DISBURSEMENT_RECREATE:        'disbursement.recreate',
  LOAN_RESTORE_BAD_LIQUIDATION: 'loan.restore_bad_liquidation',
  LOAN_RELEASE_COLLATERAL:      'loan.release_collateral',
} as const;

export type OpsAction = (typeof OPS_ACTION)[keyof typeof OPS_ACTION];

export const OPS_TARGET_TYPE = {
  USER:         'user',
  LOAN:         'loan',
  DISBURSEMENT: 'disbursement',
} as const;

export type OpsTargetType = (typeof OPS_TARGET_TYPE)[keyof typeof OPS_TARGET_TYPE];
