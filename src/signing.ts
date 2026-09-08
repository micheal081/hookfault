import { createHmac } from 'node:crypto';
/** Stripe signs the exact UTF-8 request bytes prefixed by the Unix timestamp and a dot. */
export function signStripe(
  body: string,
  secret: string,
  timestamp: number,
): string {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.`).update(body, 'utf8').digest('hex')}`;
}
