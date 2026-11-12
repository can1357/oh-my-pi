// ═══════════════════════════════════════════════════════════════════════════
// Deterministic replacement generation
// ═══════════════════════════════════════════════════════════════════════════

export const REPLACEMENT_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Generate a deterministic same-length replacement string from a secret value. */
export function generateDeterministicReplacement(secret: string): string {
	if (secret.length === 0) return "";
	const hash = BigInt(Bun.hash(secret));
	const chars: string[] = [];
	let h = hash;
	for (let i = 0; i < secret.length; i++) {
		h = h ^ (BigInt(i + 1) * 0x9e3779b97f4a7c15n);
		const idx = Number((h < 0n ? -h : h) % BigInt(REPLACEMENT_CHARS.length));
		chars.push(REPLACEMENT_CHARS[idx]!);
	}
	return chars.join("");
}

/**
 * Force a length-preserving deterministic replacement to differ from the secret
 * it stands in for, so an astronomically unlikely hash collision cannot emit
 * the raw value: flip the first char to a fixed different glyph.
 */
export function ensureDistinctReplacement(replacement: string, secret: string): string {
	if (replacement.length === 0 || replacement !== secret) return replacement;
	const alt = replacement[0] === REPLACEMENT_CHARS[0] ? REPLACEMENT_CHARS[1]! : REPLACEMENT_CHARS[0]!;
	return alt + replacement.slice(1);
}
