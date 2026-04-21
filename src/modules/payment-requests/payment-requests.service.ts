import { Inject, Injectable } from '@nestjs/common';
import { PaymentNetwork, PaymentRequestStatus, PaymentRequestType } from '@prisma/client';
import type Redis from 'ioredis';
import type { Inflow, PaymentRequest } from '@prisma/client';
import { COLLATERAL_PROVIDER, type CollateralProvider } from './collateral.provider.interface';
import { PrismaService } from '@/database/prisma.service';
import { REDIS_CLIENT } from '@/database/redis.module';
import { REDIS_KEYS, COLLATERAL_INVOICE_EXPIRY_SEC } from '@/common/constants';

const CACHE_GRACE_SEC = 5 * 60; // 5-minute grace beyond invoice expiry

export interface CreatePaymentRequestParams {
  user_id:        string;
  source_type:    'LOAN';
  source_id:      string;
  collateral_sat: bigint;
  memo:           string;
}

@Injectable()
export class PaymentRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(COLLATERAL_PROVIDER) private readonly provider: CollateralProvider,
  ) {}

  async create(params: CreatePaymentRequestParams): Promise<PaymentRequest> {
    const { user_id, source_type, source_id, collateral_sat, memo } = params;

    const { provider_reference, payment_request, receiving_address, expires_at } =
      await this.provider.createPaymentRequest({
        amount_sat:     collateral_sat,
        memo,
        expiry_seconds: COLLATERAL_INVOICE_EXPIRY_SEC,
      });

    const record = await this.prisma.paymentRequest.create({
      data: {
        user_id,
        request_type:       PaymentRequestType.COLLATERAL,
        source_type,
        source_id,
        asset:              'SAT',
        network:            PaymentNetwork.LIGHTNING,
        expected_amount:    collateral_sat.toString(),
        currency:           'SAT',
        receiving_address,
        payment_request,
        provider_reference,
        status:             PaymentRequestStatus.PENDING,
        expires_at,
      },
    });

    const ttl_sec = Math.ceil((expires_at.getTime() - Date.now()) / 1000) + CACHE_GRACE_SEC;
    await this.redis.set(
      REDIS_KEYS.PAYMENT_REQUEST_PENDING(receiving_address),
      record.id,
      'EX',
      Math.max(ttl_sec, 1),
    );

    return record;
  }

  async findPendingByReceivingAddress(receiving_address: string): Promise<PaymentRequest | null> {
    const cached_id = await this.redis.get(REDIS_KEYS.PAYMENT_REQUEST_PENDING(receiving_address));

    if (cached_id) {
      return this.prisma.paymentRequest.findFirst({
        where: { id: cached_id, status: PaymentRequestStatus.PENDING },
      });
    }

    return this.prisma.paymentRequest.findFirst({
      where: { receiving_address, status: PaymentRequestStatus.PENDING },
    });
  }

  async matchInflow(params: {
    payment_request: PaymentRequest;
    inflow: Pick<Inflow, 'id' | 'receiving_address'>;
  }): Promise<PaymentRequest> {
    const { payment_request, inflow } = params;
    const now = new Date();

    const updated = await this.prisma.$transaction(async (tx) => {
      const pr = await tx.paymentRequest.update({
        where: { id: payment_request.id },
        data: {
          status:    PaymentRequestStatus.PAID,
          inflow_id: inflow.id,
          paid_at:   now,
        },
      });
      await tx.inflow.update({
        where: { id: inflow.id },
        data: {
          is_matched:  true,
          matched_at:  now,
          source_type: payment_request.source_type,
          source_id:   payment_request.source_id,
          user_id:     payment_request.user_id,
        },
      });
      return pr;
    });

    await this.redis.del(REDIS_KEYS.PAYMENT_REQUEST_PENDING(payment_request.receiving_address));

    return updated;
  }

  async markExpired(id: string, receiving_address: string): Promise<void> {
    await this.prisma.paymentRequest.update({
      where: { id },
      data: { status: PaymentRequestStatus.EXPIRED },
    });
    await this.redis.del(REDIS_KEYS.PAYMENT_REQUEST_PENDING(receiving_address));
  }
}
