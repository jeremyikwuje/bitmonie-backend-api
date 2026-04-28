import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { OpsAction, OpsTargetType } from '@/common/constants/ops-actions';

type TxClient = Prisma.TransactionClient;

export interface OpsAuditWriteParams {
  ops_user_id: string;
  action:      OpsAction;
  target_type: OpsTargetType;
  target_id:   string;
  details?:    Record<string, unknown>;
  ip_address?: string | null;
  request_id?: string | null;
}

// Mirror of LoanStatusService.transition discipline (CLAUDE.md §5.4): the
// audit row must be written in the SAME Prisma transaction as the action it
// records. This service only accepts a TxClient, never the bare Prisma
// service — callers wrap state changes in `prisma.$transaction(async (tx) =>
// { ...action; await audit.write(tx, ...) })`.
@Injectable()
export class OpsAuditService {
  async write(tx: TxClient, params: OpsAuditWriteParams): Promise<void> {
    await tx.opsAuditLog.create({
      data: {
        ops_user_id: params.ops_user_id,
        action:      params.action,
        target_type: params.target_type,
        target_id:   params.target_id,
        details:     (params.details ?? undefined) as never,
        ip_address:  params.ip_address ?? null,
        request_id:  params.request_id ?? null,
      },
    });
  }
}
