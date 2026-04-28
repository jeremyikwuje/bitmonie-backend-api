import { OpsAuditService } from '@/modules/ops/auth/ops-audit.service';
import { OPS_ACTION, OPS_TARGET_TYPE } from '@/common/constants/ops-actions';
import type { Prisma } from '@prisma/client';

function make_tx() {
  return {
    opsAuditLog: {
      create: jest.fn().mockResolvedValue({}),
    },
  };
}

describe('OpsAuditService', () => {
  let service: OpsAuditService;
  let tx: ReturnType<typeof make_tx>;

  beforeEach(() => {
    service = new OpsAuditService();
    tx = make_tx();
  });

  it('writes audit row through the supplied tx client', async () => {
    await service.write(tx as unknown as Prisma.TransactionClient, {
      ops_user_id: 'ops-uuid',
      action:      OPS_ACTION.KYC_RESET,
      target_type: OPS_TARGET_TYPE.USER,
      target_id:   'user-uuid',
      details:     { reason: 'manual reset' },
      ip_address:  '1.2.3.4',
      request_id:  'req_abc',
    });

    expect(tx.opsAuditLog.create).toHaveBeenCalledWith({
      data: {
        ops_user_id: 'ops-uuid',
        action:      'kyc.reset',
        target_type: 'user',
        target_id:   'user-uuid',
        details:     { reason: 'manual reset' },
        ip_address:  '1.2.3.4',
        request_id:  'req_abc',
      },
    });
  });

  it('coerces missing optional fields to null', async () => {
    await service.write(tx as unknown as Prisma.TransactionClient, {
      ops_user_id: 'ops-uuid',
      action:      OPS_ACTION.KYC_PROVISION_VA,
      target_type: OPS_TARGET_TYPE.USER,
      target_id:   'user-uuid',
    });

    expect(tx.opsAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        details:    undefined,
        ip_address: null,
        request_id: null,
      }),
    });
  });
});
