import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  LOAN_APPLICATION_FILL_TIME_FLOOR_MS,
  LOAN_APPLICATION_FILL_TIME_MAX_AGE_MS,
} from '../loan-applications.constants';
import { getApplicationClientIp } from '../util/client-ip';

export type LoanApplicationDropReason = 'honeypot' | 'fill_time';

// Augments Express's Request type with the drop marker the guard sets.
// Consumed downstream by LoanApplicationsThrottlerGuard (to skip counting)
// and LoanApplicationsController (to short-circuit with an empty 201).
export interface LoanApplicationDropMarker {
  reason: LoanApplicationDropReason;
}

// Reads raw req.body (already parsed by Nest's body parser) and traps
// obvious bots BEFORE the rate-limit counter increments and BEFORE the
// DTO is validated. Always returns true — the trap is silent, not a reject.
//
// See docs/loan-applications.md §6.1–§6.2.
@Injectable()
export class BotTrapGuard implements CanActivate {
  private readonly logger = new Logger('LoanApplicationsBotTrap');

  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<Request & { _loan_application_dropped?: LoanApplicationDropMarker }>();
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object') return true;

    // §6.1 Honeypot — landing page renders `website` as a hidden, aria-hidden
    // input; real users never fill it.
    const website = body.website;
    if (typeof website === 'string' && website.trim().length > 0) {
      this._mark(req, 'honeypot');
      return true;
    }

    // §6.2 Fill-time gate — under 1.5s = obviously automated. Lenient on:
    //   - missing field           → skip
    //   - non-integer / non-number → skip
    //   - future timestamp (clock skew) → skip
    //   - stale > 24h (replay)    → skip
    const rendered_at = body.rendered_at;
    if (typeof rendered_at === 'number' && Number.isInteger(rendered_at)) {
      const elapsed = Date.now() - rendered_at;
      if (
        elapsed >= 0 &&
        elapsed <= LOAN_APPLICATION_FILL_TIME_MAX_AGE_MS &&
        elapsed < LOAN_APPLICATION_FILL_TIME_FLOOR_MS
      ) {
        this._mark(req, 'fill_time');
        return true;
      }
    }

    return true;
  }

  private _mark(
    req: Request & { _loan_application_dropped?: LoanApplicationDropMarker },
    reason: LoanApplicationDropReason,
  ): void {
    req._loan_application_dropped = { reason };
    this.logger.log(
      {
        event: 'loan_application_dropped',
        reason,
        client_ip: getApplicationClientIp(req),
        user_agent: (req.headers['user-agent'] ?? '').slice(0, 256),
      },
      `loan_application_dropped reason=${reason}`,
    );
  }
}
