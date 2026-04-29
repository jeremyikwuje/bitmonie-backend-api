import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/database/prisma.service';

export const WebhookOutcome = {
  RECEIVED:          'RECEIVED',           // initial — set by record()
  SIGNATURE_INVALID: 'SIGNATURE_INVALID',  // signature verification failed
  MALFORMED:         'MALFORMED',          // body not valid JSON / failed schema validation
  IGNORED:           'IGNORED',            // valid but no action taken (already terminal, unmatched, non-success status)
  PROCESSED:         'PROCESSED',          // resulted in a state change (handleSuccess / handleFailure / loan activate / inflow credit)
  DEFERRED:          'DEFERRED',           // valid but waiting on something (e.g. status query says still processing)
  ERROR:             'ERROR',              // handler threw mid-flight
} as const;

export type WebhookOutcomeValue = (typeof WebhookOutcome)[keyof typeof WebhookOutcome];

export interface RecordParams {
  provider:        string;
  http_method:     string;
  http_path:       string;
  headers?:        Record<string, string | string[] | undefined>;
  raw_body:        string;
}

export interface UpdateOutcomeParams {
  outcome:            WebhookOutcomeValue;
  outcome_detail?:    string;
  signature_valid?:   boolean;
  external_reference?: string;
}

// PII fields that get masked in stored bodies per CLAUDE.md §5.8. The list is
// the union across all providers we accept webhooks from — extending it is
// safer than under-redacting. Mask leaves the last 4 chars visible so triage
// can still correlate ("****6789" → matches the customer's bank account in
// disbursement_accounts) without storing the raw value.
const PII_FIELDS = new Set<string>([
  // PalmPay collection notification
  'payerAccountNo',
  // PalmPay payout request body — never inbound, but defensive if we ever
  // log outbound bodies on this path
  'payeeBankAccNo',
  'bankAccNo',
  // KYC / virtual account fields (BVN / NIN)
  'licenseNumber',
  'bvn',
  'nin',
  'identityNumber',
]);

const HEADER_ALLOWLIST = new Set<string>([
  'content-type',
  'content-length',
  'user-agent',
  'x-request-id',
  'x-forwarded-for',
  'svix-id',
  'svix-timestamp',
  // svix-signature is the signature itself — non-secret (it's just an HMAC
  // over the body) and useful for debugging signature failures, so allowed.
  'svix-signature',
]);

function maskValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value.length <= 4) return '****';
  return `****${value.slice(-4)}`;
}

function redactPiiInPlace(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(redactPiiInPlace);
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = PII_FIELDS.has(k) ? maskValue(v) : redactPiiInPlace(v);
    }
    return out;
  }
  return node;
}

function selectHeaders(
  raw?: Record<string, string | string[] | undefined>,
): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    const normalized = name.toLowerCase();
    if (!HEADER_ALLOWLIST.has(normalized)) continue;
    if (Array.isArray(value)) out[normalized] = value.join(', ');
    else if (value !== undefined) out[normalized] = value;
  }
  return out;
}

// Attempts to redact PII inside `raw_body` if it parses as JSON. If parsing
// fails we store the body verbatim — provider sent something we don't
// understand and the verbatim text is itself a useful diagnostic. Falls back
// to truncating at 32k chars to bound row size; webhooks rarely exceed a few
// kilobytes but a runaway provider response shouldn't fill our table.
function redactRawBody(raw_body: string): string {
  const MAX_LENGTH = 32_768;
  let body = raw_body;
  try {
    const parsed = JSON.parse(raw_body) as unknown;
    body = JSON.stringify(redactPiiInPlace(parsed));
  } catch {
    // Not JSON — store as-is. Preserves useful debug info for malformed cases.
  }
  if (body.length > MAX_LENGTH) {
    body = body.slice(0, MAX_LENGTH) + '…[truncated]';
  }
  return body;
}

@Injectable()
export class WebhooksLogService {
  private readonly logger = new Logger(WebhooksLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Phase 1 — call BEFORE signature verification so we have a row even if
  // the handler throws before reaching the outcome update. Returns the row
  // id; pass it to updateOutcome() at every terminal branch.
  //
  // Best-effort: a DB failure here must NOT break the webhook handler — we
  // log the failure and return an empty string. The caller treats an empty
  // id as "no row to update" and skips the second phase.
  async record(params: RecordParams): Promise<string> {
    try {
      const row = await this.prisma.webhookLog.create({
        data: {
          provider:    params.provider,
          http_method: params.http_method,
          http_path:   params.http_path,
          headers:     selectHeaders(params.headers) as never,
          raw_body:    redactRawBody(params.raw_body),
          body_length: params.raw_body.length,
          outcome:     WebhookOutcome.RECEIVED,
        },
      });
      return row.id;
    } catch (err) {
      this.logger.error(
        { provider: params.provider, error: err instanceof Error ? err.message : String(err) },
        'WebhooksLog: failed to record webhook entry — handler proceeds without log row',
      );
      return '';
    }
  }

  // Phase 2 — terminal update. No-op if id is empty (record() failed) so
  // callers can wire this in without conditional checks.
  async updateOutcome(id: string, params: UpdateOutcomeParams): Promise<void> {
    if (!id) return;
    try {
      await this.prisma.webhookLog.update({
        where: { id },
        data: {
          outcome:            params.outcome,
          outcome_detail:     params.outcome_detail ?? null,
          signature_valid:    params.signature_valid ?? null,
          external_reference: params.external_reference ?? null,
          processed_at:       new Date(),
        },
      });
    } catch (err) {
      this.logger.error(
        { id, outcome: params.outcome, error: err instanceof Error ? err.message : String(err) },
        'WebhooksLog: failed to update outcome — row stays in RECEIVED',
      );
    }
  }
}
