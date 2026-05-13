import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { getApplicationClientIp } from '../util/client-ip';
import type { LoanApplicationDropMarker } from './bot-trap.guard';

// Subclass of @nestjs/throttler's ThrottlerGuard that:
//   1. Keys per-IP by parsing X-Forwarded-For directly, so the per-IP cap
//      works behind a reverse proxy without relying on a project-wide
//      `app.set('trust proxy', ...)` change.
//   2. Skips counting when BotTrapGuard has marked the request as dropped —
//      otherwise a single bot on a shared NAT could exhaust the cap for
//      every legitimate caller behind that IP.
//
// See docs/loan-applications.md §6.3.
@Injectable()
export class LoanApplicationsThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Request): Promise<string> {
    return getApplicationClientIp(req) ?? 'unknown';
  }

  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { _loan_application_dropped?: LoanApplicationDropMarker }>();
    return req._loan_application_dropped !== undefined;
  }
}
