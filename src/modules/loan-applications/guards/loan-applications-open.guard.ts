import { CanActivate, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '@/config/app.config';
import { LoanApplicationsClosedException } from '@/common/errors/bitmonie.errors';

// Global on/off switch for public intake. Registered FIRST on the route so a
// closed endpoint does no other work: no bot-trap logging, no throttle
// counting, no body validation, no persistence, no ops email.
@Injectable()
export class LoanApplicationsOpenGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(): boolean {
    if (this.config.get<AppConfig>('app')?.loan_applications_open !== true) {
      throw new LoanApplicationsClosedException();
    }
    return true;
  }
}
