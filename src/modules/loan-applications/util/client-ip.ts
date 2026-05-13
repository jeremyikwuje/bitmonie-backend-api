import type { Request } from 'express';

// Extract the visitor IP from X-Forwarded-For (leftmost hop), falling back to
// the socket remote address. Called for both audit capture and throttle keying
// so the per-IP limit isn't accidentally tied to the reverse-proxy IP.
//
// Defensive against arrays (`X-Forwarded-For` can theoretically appear multiple
// times) and against an empty string from a misbehaving proxy.
export function getApplicationClientIp(req: Request): string | null {
  const header = req.headers['x-forwarded-for'];
  let first_value: string | undefined;

  if (typeof header === 'string') {
    first_value = header;
  } else if (Array.isArray(header) && header.length > 0) {
    first_value = header[0];
  }

  if (first_value) {
    const first_hop = first_value.split(',')[0]?.trim();
    if (first_hop) return first_hop;
  }

  return req.socket?.remoteAddress ?? null;
}
