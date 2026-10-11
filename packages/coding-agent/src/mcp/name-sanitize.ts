/**
 * One identifier spelling for a tool or server name across two domains.
 *
 * Two domains, one function:
 * - `mint`: validator-strict normalization for `mcp__…` registry names
 *   (lowercase, hyphen folded to `_`, digits controlled by `keepDigits`,
 *   underscores collapsed and trimmed, caller's fallback substituted when empty).
 * - `filter`: preserves case, digits, and hyphens (SEP-986 `[a-zA-Z0-9_-]`).
 *   Values already inside the alphabet are returned byte-identical to maintain
 *   injectivity; characters outside the alphabet collapse to `_` with edge
 *   underscores trimmed.
 */
export interface SanitizeNamePartOptions {
	domain: "mint" | "filter";
	keepDigits?: boolean;
}

export function sanitizeNamePart(value: string, fallback: string, opts: SanitizeNamePartOptions): string {
	if (opts.domain === "filter") {
		// FILTER domain: a value already inside the advertised-name alphabet is
		// returned byte-identical. That domain must stay injective over the names it
		// has to distinguish — `_` is part of the alphabet, so collapsing or
		// trimming here would let an entry for `read` also select a separately
		// advertised `_read`, and `foo_bar` also select `foo__bar`.
		if (/^[A-Za-z0-9_-]+$/.test(value)) return value;
		const sanitized = value
			.replace(/[^A-Za-z0-9_-]+/g, "_")
			.replace(/_+/g, "_")
			.replace(/^_+|_+$/g, "");

		return sanitized.length > 0 ? sanitized : fallback;
	}

	// MINT domain: validator-strict normalization for `mcp__<server>_<tool>`.
	// Lowercase, hyphen folded to `_`, and doubled underscores collapsed so the
	// server/tool boundary is preserved. `keepDigits` selects current vs legacy mint.
	const keepDigits = opts.keepDigits ?? true;
	const sanitized = value
		.toLowerCase()
		.replace(keepDigits ? /[^a-z0-9_]+/g : /[^a-z_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");

	return sanitized.length > 0 ? sanitized : fallback;
}
