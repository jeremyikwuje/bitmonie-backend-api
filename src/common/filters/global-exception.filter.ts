import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
  request_id?: string;
  kyc_required?: boolean;
  prompt_kyc?: string;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const request_id =
      (request.headers['x-request-id'] as string | undefined) ?? undefined;

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: ErrorBody = {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
    };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const payload = exception.getResponse();
      if (typeof payload === 'string') {
        body = { code: this.codeForStatus(status), message: payload };
      } else if (typeof payload === 'object' && payload !== null) {
        const obj = payload as Record<string, unknown>;
        body = {
          code: (obj.code as string) ?? this.codeForStatus(status),
          message:
            typeof obj.message === 'string'
              ? obj.message
              : Array.isArray(obj.message)
                ? obj.message.join(', ')
                : exception.message,
          details: obj.details ?? (Array.isArray(obj.message) ? obj.message : undefined),
          ...(obj.kyc_required !== undefined && { kyc_required: obj.kyc_required as boolean }),
          ...(obj.prompt_kyc !== undefined && { prompt_kyc: obj.prompt_kyc as string }),
        };
      }
    } else {
      this.logger.error(
        { msg: 'Unhandled exception', request_id, path: request.url },
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    if (request_id) body.request_id = request_id;

    response.status(status).json({ error: body });
  }

  private codeForStatus(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:           return 'BAD_REQUEST';
      case HttpStatus.UNAUTHORIZED:          return 'UNAUTHORIZED';
      case HttpStatus.FORBIDDEN:             return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:             return 'NOT_FOUND';
      case HttpStatus.CONFLICT:              return 'CONFLICT';
      case HttpStatus.UNPROCESSABLE_ENTITY:  return 'UNPROCESSABLE_ENTITY';
      case HttpStatus.TOO_MANY_REQUESTS:     return 'TOO_MANY_REQUESTS';
      default:                               return 'INTERNAL_ERROR';
    }
  }
}
