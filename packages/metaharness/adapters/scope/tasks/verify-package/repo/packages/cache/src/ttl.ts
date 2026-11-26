const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

/**
 * Milliseconds in a TTL such as `250ms`, `90s`, `5m`, or `2h`.
 * @throws on a missing or unknown unit, or a non-positive amount.
 */
export function parseTtl(ttl: string): number {
	const match = /^(\d+)(ms|s|m|h)$/.exec(ttl);
	if (!match || Number(match[1]) <= 0) throw new Error(`invalid ttl: ${ttl}`);
	return Number(match[1]) * UNIT_MS[match[2]];
}

/**
 * When an entry stored at `now` (epoch ms) with `ttl` expires. Expiry lands on a whole second,
 * rounded up, so an entry never expires earlier than asked.
 */
export function expiresAt(now: number, ttl: string): number {
	return Math.ceil((now + parseTtl(ttl)) / 1_000) * 1_000;
}
