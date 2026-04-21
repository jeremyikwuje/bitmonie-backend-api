import { Injectable, Logger } from '@nestjs/common';
import { PaymentNetwork } from '@prisma/client';
import type { Decimal } from 'decimal.js';
import type { Inflow, PaymentRequest } from '@prisma/client';
import { PrismaService } from '@/database/prisma.service';
import { PaymentRequestsService } from '@/modules/payment-requests/payment-requests.service';

export interface IngestInflowParams {
  asset:              string;
  amount:             Decimal;
  currency:           string;
  network:            PaymentNetwork;
  receiving_address:  string;
  provider_reference: string;
  sender_address?:    string;
  provider_response?: Record<string, unknown>;
}

export interface IngestResult {
  inflow:           Inflow;
  payment_request:  PaymentRequest | null;
}

@Injectable()
export class InflowsService {
  private readonly logger = new Logger(InflowsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payment_requests: PaymentRequestsService,
  ) {}

  async ingest(params: IngestInflowParams): Promise<IngestResult> {
    const inflow = await this._createInflow(params);

    const pending_pr = await this.payment_requests.findPendingByReceivingAddress(
      params.receiving_address,
    );

    if (!pending_pr) {
      this.logger.warn(
        { receiving_address: params.receiving_address, provider_reference: params.provider_reference },
        'Inflow received with no matching PaymentRequest — stored unmatched',
      );
      return { inflow, payment_request: null };
    }

    const matched_pr = await this.payment_requests.matchInflow({
      payment_request: pending_pr,
      inflow,
    });

    return { inflow, payment_request: matched_pr };
  }

  private async _createInflow(params: IngestInflowParams): Promise<Inflow> {
    try {
      return await this.prisma.inflow.create({
        data: {
          asset:              params.asset,
          amount:             params.amount,
          currency:           params.currency,
          network:            params.network,
          receiving_address:  params.receiving_address,
          provider_reference: params.provider_reference,
          sender_address:     params.sender_address,
          provider_response:  params.provider_response as never,
          is_matched:         false,
        },
      });
    } catch (err: unknown) {
      // P2002 = unique constraint violation — duplicate provider_reference
      if (this._is_prisma_unique_violation(err)) {
        this.logger.warn(
          { provider_reference: params.provider_reference },
          'Duplicate inflow received — returning existing row',
        );
        return this.prisma.inflow.findUniqueOrThrow({
          where: { provider_reference: params.provider_reference },
        });
      }
      throw err;
    }
  }

  private _is_prisma_unique_violation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: string }).code === 'P2002'
    );
  }
}
