import { Injectable, Logger } from '@nestjs/common';
import type { LoanApplication } from '@prisma/client';
import Decimal from 'decimal.js';
import { LoanApplicationsRepository } from './loan-applications.repository';
import {
  COLLATERAL_DISPLAY_TO_ENUM,
  COLLATERAL_ENUM_TO_DISPLAY,
  type LoanApplicationCollateralDisplay,
} from './loan-applications.constants';
import { OpsAlertsService } from '@/modules/ops-alerts/ops-alerts.service';

export interface CreateLoanApplicationParams {
  first_name:             string;
  last_name:              string;
  email:                  string;
  phone:                  string;
  collateral_type_display: LoanApplicationCollateralDisplay;
  collateral_description: string;
  loan_amount_ngn:        number;
  client_ip:              string | null;
  user_agent:             string | null;
}

@Injectable()
export class LoanApplicationsService {
  private readonly logger = new Logger(LoanApplicationsService.name);

  constructor(
    private readonly repo: LoanApplicationsRepository,
    private readonly ops_alerts: OpsAlertsService,
  ) {}

  async create(params: CreateLoanApplicationParams): Promise<LoanApplication> {
    const collateral_enum = COLLATERAL_DISPLAY_TO_ENUM[params.collateral_type_display];

    const application = await this.repo.create({
      first_name:             params.first_name,
      last_name:              params.last_name,
      email:                  params.email,
      phone:                  params.phone,
      collateral_type:        collateral_enum,
      collateral_description: params.collateral_description,
      loan_amount_ngn:        new Decimal(params.loan_amount_ngn),
      client_ip:              params.client_ip,
      user_agent:             params.user_agent,
    });

    this.logger.log(
      { application_id: application.id },
      'loan_application_created',
    );

    // Fire-and-forget. Email send failure must not fail the request —
    // persistence is the source of truth. Match OpsAlertsService discipline.
    void this.ops_alerts
      .alertNewLoanApplication({
        application_id:          application.id,
        first_name:              application.first_name,
        last_name:               application.last_name,
        email:                   application.email,
        phone:                   application.phone,
        collateral_type_display: COLLATERAL_ENUM_TO_DISPLAY[application.collateral_type],
        collateral_description:  application.collateral_description,
        loan_amount_ngn:         this._formatNgn(application.loan_amount_ngn),
        created_at:              application.created_at,
      })
      .catch((err) => {
        this.logger.error(
          {
            application_id: application.id,
            error: err instanceof Error ? err.message : String(err),
          },
          'loan_application_email_failed',
        );
      });

    return application;
  }

  // Format a Prisma Decimal as a thousands-separated naira amount with two
  // decimal places dropped when whole (e.g. "5,000,000" not "5,000,000.00").
  // Used in the subject line + body of the ops email.
  private _formatNgn(value: unknown): string {
    const as_decimal = new Decimal(value as Decimal.Value);
    const whole = as_decimal.isInteger() ? as_decimal.toFixed(0) : as_decimal.toFixed(2);
    // Insert thousands separators on the integer part only.
    const parts = whole.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }
}
