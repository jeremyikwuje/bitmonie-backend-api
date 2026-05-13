import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
  type ValidationError,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { CreateLoanApplicationDto } from './dto/create-loan-application.dto';
import { LoanApplicationsService } from './loan-applications.service';
import { BotTrapGuard, type LoanApplicationDropMarker } from './guards/bot-trap.guard';
import { LoanApplicationsThrottlerGuard } from './guards/loan-applications-throttler.guard';
import {
  LOAN_APPLICATION_THROTTLE_LIMIT,
  LOAN_APPLICATION_THROTTLE_TTL_MS,
} from './loan-applications.constants';
import { getApplicationClientIp } from './util/client-ip';

type LoanApplicationRequest = Request & {
  _loan_application_dropped?: LoanApplicationDropMarker;
};

// Convert class-validator's nested ValidationError tree into the standard
// `details: [{ field, issue }]` shape used elsewhere by BitmonieException.
// This makes the response indistinguishable from a manually-thrown typed
// exception — the doc's acceptance tests assert against this shape.
function buildValidationException(errors: ValidationError[]): BadRequestException {
  const details: Array<{ field: string; issue: string }> = [];
  for (const err of errors) {
    if (err.constraints) {
      for (const issue of Object.values(err.constraints)) {
        details.push({ field: err.property, issue });
      }
    }
  }
  return new BadRequestException({
    code: 'VALIDATION_FAILED',
    message: 'Request body failed validation.',
    details,
  });
}

@ApiTags('loan-applications')
@Controller('loan-applications')
export class LoanApplicationsController {
  constructor(private readonly service: LoanApplicationsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  // Bot-trap MUST come before the throttler so a tripped submission
  // doesn't consume the per-IP quota. Both run before the validation pipe.
  @UseGuards(BotTrapGuard, LoanApplicationsThrottlerGuard)
  @Throttle({
    default: {
      ttl:   LOAN_APPLICATION_THROTTLE_TTL_MS,
      limit: LOAN_APPLICATION_THROTTLE_LIMIT,
    },
  })
  @UsePipes(
    new ValidationPipe({
      whitelist:           true,
      forbidNonWhitelisted: true,
      transform:           true,
      transformOptions:    { enableImplicitConversion: false },
      exceptionFactory:    buildValidationException,
    }),
  )
  @ApiOperation({
    summary:     'Submit a public loan application',
    description: 'Public, unauthenticated. Persists the application and notifies ops by email. Honeypot + fill-time bot traps silently drop suspicious submissions.',
  })
  @ApiResponse({ status: 201, description: 'Application accepted' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 429, description: 'Rate limited' })
  async create(
    @Body() dto: CreateLoanApplicationDto,
    @Req()  req: LoanApplicationRequest,
  ): Promise<{ application_id: string } | undefined> {
    // Bot-trap fired earlier in the request lifecycle (BotTrapGuard).
    // Return 201 with no body so the bot can't tell its submission was dropped.
    if (req._loan_application_dropped) return undefined;

    const application = await this.service.create({
      first_name:              dto.first_name,
      last_name:               dto.last_name,
      email:                   dto.email,
      phone:                   dto.phone,
      collateral_type_display: dto.collateral_type,
      collateral_description:  dto.collateral_description,
      loan_amount_ngn:         dto.loan_amount_ngn,
      client_ip:               getApplicationClientIp(req),
      user_agent:              (req.headers['user-agent'] ?? null)?.toString().slice(0, 512) ?? null,
    });

    return { application_id: application.id };
  }
}
