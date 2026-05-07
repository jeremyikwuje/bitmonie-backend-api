import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/database/prisma.service';
import { AuthService } from './auth.service';
import { TransactionPinService } from './transaction-pin.service';
import {
  TransactionFactorRequiredException,
  TransactionFactorNotSetException,
} from '@/common/errors/bitmonie.errors';

export interface TransactionFactor {
  transaction_pin?: string;
  totp_code?:       string;
}

// Step-up factor verification for sensitive transactional ops — currently
// the collateral release-address change flow (CLAUDE.md §5.4a).
//
// Contract:
//   - The user MUST have at least one of {transaction PIN, TOTP} configured.
//     If neither is set, refuse outright with TransactionFactorNotSetException.
//   - The caller MUST submit exactly one of {transaction_pin, totp_code}.
//     Submitting neither → TransactionFactorRequiredException.
//   - When both are submitted, prefer transaction_pin (a typo on the unused
//     field shouldn't reject the whole request). We don't validate "exactly
//     one" because being lenient here keeps a single error path.
//   - When the submitted factor is one the user hasn't configured (e.g.
//     totp_code submitted but 2FA disabled), Auth2faRequiredException or
//     TransactionPinNotSetException bubbles up from the underlying verify.
//
// IMPORTANT: this is the only place a sensitive op should consult PIN/TOTP.
// Don't reach into TransactionPinService.verifyPinOrThrow or
// AuthService.verifyTotpForUser directly from a feature module — the
// preconditions and error semantics belong here.
@Injectable()
export class StepUpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth_service: AuthService,
    private readonly transaction_pin_service: TransactionPinService,
  ) {}

  async assertHasAnyFactorConfigured(user_id: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where:  { id: user_id },
      select: { totp_enabled: true, transaction_pin_hash: true },
    });
    if (!user.totp_enabled && !user.transaction_pin_hash) {
      throw new TransactionFactorNotSetException();
    }
  }

  async verifyTransactionFactor(user_id: string, factor: TransactionFactor): Promise<void> {
    await this.assertHasAnyFactorConfigured(user_id);

    if (factor.transaction_pin) {
      await this.transaction_pin_service.verifyPinOrThrow(user_id, factor.transaction_pin);
      return;
    }
    if (factor.totp_code) {
      await this.auth_service.verifyTotpForUser(user_id, factor.totp_code);
      return;
    }
    throw new TransactionFactorRequiredException();
  }
}
