const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 1_000, h: 3_600_000 };

/** Parses `250ms`, `90s`, `2m`, or `1h` into milliseconds. */
export function parseDuration(text: string): number {
	const match = /^(\d+)(ms|s|m|h)$/.exec(text.trim());
	if (!match) throw new Error(`invalid duration: ${text}`);
	return Number(match[1]) * UNIT_MS[match[2]];
}
