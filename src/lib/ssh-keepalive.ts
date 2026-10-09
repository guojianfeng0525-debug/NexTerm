/** Defaults favour maintaining the existing session through short network stalls. */
export const SSH_KEEPALIVE_INTERVAL = 15;
export const SSH_KEEPALIVE_MAX = 20;

export function positiveKeepaliveValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.min(Math.floor(value), 86400) : fallback;
}

export const SSH_KEEPALIVE_MIN_INTERVAL = 5;

export function keepaliveInterval(value: number | undefined, fallback = SSH_KEEPALIVE_INTERVAL): number {
  return Math.max(SSH_KEEPALIVE_MIN_INTERVAL, positiveKeepaliveValue(value, fallback));
}
