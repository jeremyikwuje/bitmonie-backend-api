import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, from, of, switchMap, tap } from 'rxjs';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '@/database/redis.module';
import {
  IDEMPOTENCY_TTL_SEC,
  REDIS_KEYS,
} from '@/common/constants';
import { IdempotencyConflictException } from '@/common/errors/bitmonie.errors';

interface CachedResponse {
  status: number;
  body: unknown;
}

const IN_FLIGHT_MARKER = '__in_flight__';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<
      Request & { user?: { id: string } }
    >();

    if (!['POST', 'PUT', 'PATCH'].includes(request.method)) {
      return next.handle();
    }

    const idempotency_key = request.header('Idempotency-Key');
    if (!idempotency_key || !request.user?.id) {
      return next.handle();
    }

    const redis_key = REDIS_KEYS.IDEMPOTENCY(request.user.id, idempotency_key);

    return from(this.redis.get(redis_key)).pipe(
      switchMap((existing) => {
        if (existing === IN_FLIGHT_MARKER) {
          throw new IdempotencyConflictException();
        }
        if (existing) {
          const cached = JSON.parse(existing) as CachedResponse;
          const response = context.switchToHttp().getResponse<Response>();
          response.status(cached.status);
          return of(cached.body);
        }

        return from(this.redis.set(redis_key, IN_FLIGHT_MARKER, 'EX', 60, 'NX')).pipe(
          switchMap((set_result) => {
            if (set_result === null) {
              throw new IdempotencyConflictException();
            }
            return next.handle().pipe(
              tap((body: unknown) => {
                const response = context.switchToHttp().getResponse<Response>();
                const cached: CachedResponse = {
                  status: response.statusCode,
                  body,
                };
                void this.redis.set(
                  redis_key,
                  JSON.stringify(cached, (_k, v) =>
                    typeof v === 'bigint' ? v.toString() : v,
                  ),
                  'EX',
                  IDEMPOTENCY_TTL_SEC,
                );
              }),
            );
          }),
        );
      }),
    );
  }
}
