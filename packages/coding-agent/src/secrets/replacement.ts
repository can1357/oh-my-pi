// ═══════════════════════════════════════════════════════════════════════════
// Deterministic replacement generation
// ═══════════════════════════════════════════════════════════════════════════

export const REPLACEMENT_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const NONMATCHING_REPLACEMENT_CHARS = `${REPLACEMENT_CHARS}!#$%&()*+,-./:;<=>?@[]^_{|}~`;
// Whitespace bytes used to build last-resort redactions for a default replace
// regex that matches every non-whitespace candidate (e.g. `\S{n}`). Only
// `space`/`tab` are used — never a line terminator — so a `.`-style
// match-everything regex (which matches space and tab but not `\n`) still
// exhausts to the sentinel instead of redacting to a newline run.
const WHITESPACE_REPLACEMENT_CHARS = " \t";

/** Generate a deterministic same-length replacement string from a secret value. */
export function generateDeterministicReplacement(secret: string): string {
	if (secret.length === 0) return "";
	// Prefix generated chunks with a fixed `ZZ` so re-redacting an already-emitted
	// 1–2 char chunk is a fixed point (the deterministic replacement of a <=2-char
	// value is itself `Z`/`ZZ`), keeping short default-replacement remainders next
	// to a reversible placeholder stable across an obfuscator restart.
	const hash = BigInt(Bun.hash(secret));
	const chars = secret.length === 1 ? ["Z"] : ["Z", "Z"];
	let h = hash;
	for (let i = chars.length; i < secret.length; i++) {
		h = h ^ (BigInt(i + 1) * 0x9e3779b97f4a7c15n);
		const idx = Number((h < 0n ? -h : h) % BigInt(REPLACEMENT_CHARS.length));
		chars.push(REPLACEMENT_CHARS[idx]);
	}
	return chars.join("");
}

/**
 * Force a length-preserving deterministic replacement to differ from the secret
 * it stands in for. `generateDeterministicReplacement` seeds its first 1–2 chars
 * with the `Z`/`ZZ` sentinel, so a whole configured value that is exactly `Z` or
 * `ZZ` (or an astronomically unlikely longer hash collision) would otherwise be
 * emitted unchanged and ship the raw secret to the provider. Flip the first char
 * to a fixed different glyph: same length, still deterministic, guaranteed != the
 * secret. Only safe for a whole CONFIGURED value (a plain secret matches its own
 * literal, so the perturbed output is no longer matched and stays a fixed point);
 * per-chunk remainders must keep the sentinel to remain idempotent across restart.
 */
export function ensureDistinctReplacement(replacement: string, secret: string): string {
	if (replacement.length === 0 || replacement !== secret) return replacement;
	const alt = replacement[0] === REPLACEMENT_CHARS[0] ? REPLACEMENT_CHARS[1] : REPLACEMENT_CHARS[0];
	return alt + replacement.slice(1);
}

// How far left of the matched span the re-match scan begins looking for a match
// that overlaps the candidate. This bounds ONLY the match-start search position,
// never the lookbehind/lookahead context: the probe below substitutes the
// candidate into the FULL text, so a regex's lookbehind/lookahead assertions
// always evaluate against complete context regardless of width. The single
// re-match this misses is one that begins more than this many bytes before the
// span and extends into it (a single match longer than the window) — that only
// churns the chosen redaction marker between candidates, never back to the raw
// matched value, so it cannot leak a secret.
const REGEX_REMATCH_BACKSCAN = 512;

export interface RegexMatchContext {
	/** Full text the match was found in (positions are offsets into it). */
	text: string;
	/** Start/end of the matched span being replaced. */
	start: number;
	end: number;
}

/**
 * Whether `candidate`, substituted for the matched span in its surrounding text,
 * is re-matched by `regex` at its own position. A replace-mode regex that depends
 * on context (lookbehind/lookahead/`\b`) can match a candidate that does NOT match
 * in isolation: e.g. `(?<=api=)[AZ]` never matches a bare `A`, but `api=A` does, so
 * a candidate `A` chosen by an isolation test is re-redacted on the next obfuscate()
 * pass and can oscillate back to the raw matched value. The probe substitutes the
 * candidate into the FULL text — not a truncated window — so a wide lookbehind or
 * lookahead (e.g. `(?<=A{600})`) still evaluates against the context that makes it
 * match. Truncating that context dropped the assertion's reach and falsely
 * accepted an oscillating, leaky candidate. The scan starts a bounded distance
 * left of the span and stops once a match begins at/after the span's end (matches
 * arrive in order), keeping per-candidate cost independent of total text length.
 */
export function regexRematchesInContext(candidate: string, regex: RegExp, ctx: RegexMatchContext): boolean {
	const probe = ctx.text.slice(0, ctx.start) + candidate + ctx.text.slice(ctx.end);
	const spanStart = ctx.start;
	const spanEnd = spanStart + candidate.length;
	regex.lastIndex = Math.max(0, spanStart - REGEX_REMATCH_BACKSCAN);
	for (let m = regex.exec(probe); m !== null; m = regex.exec(probe)) {
		const matchStart = m.index;
		const matchEnd = m.index + m[0].length;
		// Matches arrive in increasing position; once one starts at or past the
		// span's end it cannot cover the candidate, and neither can any later one.
		if (matchStart >= spanEnd) break;
		// A match overlapping the candidate's own bytes means those bytes get
		// re-redacted on a later pass — not a fixed point.
		if (matchEnd > spanStart) return true;
		// Zero-width matches do not advance lastIndex; step past to avoid a loop.
		if (m[0].length === 0) regex.lastIndex++;
	}
	return false;
}

/**
 * Search same-length replacements for one the regex does NOT match, so a default
 * regex secret whose deterministic replacement collides with its own value (the
 * `Z`/`ZZ` sentinel, or an astronomical hash collision) is still redacted to a
 * STABLE nonmatching value instead of shipping the raw secret. A nonmatching
 * candidate is a fixed point under re-obfuscation — the regex never re-matches it,
 * so it cannot re-leak on a later pass. The search stays bounded to O(length *
 * alphabet) regardless of value length: first exhaust every single-position
 * substitution against a deterministic baseline (`AAAA…`, then `!AAA…`, `A!AA…`,
 * …) so any regex that only needs one out-of-class byte — regardless of position —
 * is found in a handful of probes rather than enumerating every combination (which
 * for a 3-byte match-everything config, e.g. `[\s\S]{3}`, would otherwise run
 * 90**3 = 729000 candidates through the regex on every single match, stalling
 * provider requests). Candidates are enumerated deterministically over a stable
 * ASCII alphabet: alphanumerics first (usually enough), then punctuation fallback
 * bytes when the regex covers every alphanumeric candidate. When the regex still
 * matches around a lone perturbed byte (for example `[A-Za-z0-9].*` matching the
 * unperturbed tail), full-width same-byte candidates (`!!!!!`, `_____`, …) are
 * tried next. When the regex covers every non-whitespace candidate (e.g. `\S{n}`),
 * whitespace markers (a full space/tab run, then a single whitespace byte among
 * non-whitespace filler) are tried as a last resort. A genuine match-everything
 * regex (`.`/`[\s\S]`, which also matches space and tab) still exhausts this bounded
 * sweep and returns undefined, letting the caller keep its own fixed-point fallback
 * — bounded search can in principle miss an escape that depends jointly on
 * multiple positions in a way no single-position swap reaches, but no realistic
 * secret-redaction regex (character classes, literal matches, anchored/bounded
 * repeats) has that shape.
 */
export function findNonMatchingReplacement(
	value: string,
	regex: RegExp,
	context: RegexMatchContext,
): string | undefined {
	const len = value.length;
	if (len === 0) return undefined;
	// Exhaust every single-position substitution against the deterministic baseline
	// first (covers the common case cheaply), then fall back to full-width same-byte
	// candidates for a regex that only rejects a lone perturbed byte in context.
	const baseline = NONMATCHING_REPLACEMENT_CHARS[0].repeat(len);
	for (let position = 0; position < len; position++) {
		for (const ch of NONMATCHING_REPLACEMENT_CHARS) {
			const candidate = `${baseline.slice(0, position)}${ch}${baseline.slice(position + 1)}`;
			if (candidate === value) continue;
			if (!regexRematchesInContext(candidate, regex, context)) return candidate;
		}
	}
	// If the regex can still match around a lone punctuation byte (for example
	// `[A-Za-z0-9].*` matching the `AAAA` tail of `!AAAA`), try full-width
	// same-byte fallbacks like `!!!!!`, `_____`, etc. before giving up.
	for (const ch of NONMATCHING_REPLACEMENT_CHARS) {
		const candidate = ch.repeat(len);
		if (candidate === value) continue;
		if (!regexRematchesInContext(candidate, regex, context)) return candidate;
	}
	return findWhitespaceFallbackReplacement(value, regex, context);
}

/**
 * Last-resort fallback for a default replace regex that matches every
 * non-whitespace candidate. Builds same-length whitespace markers the regex
 * cannot match: first a full space/tab run (handles `\S`-class patterns), then a
 * single whitespace byte among non-whitespace filler (` AAAA`, `A AAA`, …). The
 * mixed marker defeats regexes that ALSO match all-space/all-tab runs, e.g.
 * `(?:\S{n}| {n}|\t{n})`, because the lone whitespace byte breaks every
 * fixed-length run. A genuine match-everything regex (`.`/`[\s\S]`) matches the
 * filler and the whitespace alike, so this still returns undefined there, keeping
 * the caller's sentinel as the sole fixed point.
 */
function findWhitespaceFallbackReplacement(
	value: string,
	regex: RegExp,
	context: RegexMatchContext,
): string | undefined {
	const len = value.length;
	const filler = NONMATCHING_REPLACEMENT_CHARS[0];
	for (const ws of WHITESPACE_REPLACEMENT_CHARS) {
		const full = ws.repeat(len);
		if (full !== value) {
			if (!regexRematchesInContext(full, regex, context)) return full;
		}
		for (let pos = 0; pos < len; pos++) {
			const candidate = `${filler.repeat(pos)}${ws}${filler.repeat(len - pos - 1)}`;
			if (candidate === value) continue;
			if (!regexRematchesInContext(candidate, regex, context)) return candidate;
		}
	}
	return undefined;
}

/**
 * Whether a default (no custom `replacement`) replace-mode regex can never
 * safely redact a 1-2 char match: `findNonMatchingReplacement`'s bounded
 * search — the same search `#generateRegexReplacement` runs at match time —
 * finds no candidate the regex fails to re-match. This holds independent of
 * any actual per-install key: the search already exhausts every character in
 * `REPLACEMENT_CHARS` (the alphabet `buildKeyedReplacementRun` draws its
 * fallback marker from) plus punctuation and whitespace, so if none of those
 * escape the regex, no key-derived marker drawn from the same alphabet can
 * either — the marker is guaranteed to re-match too, making every such match
 * unresolvable: the fallback could only ever emit the raw matched text
 * unchanged. Probed with a value (`"\0".repeat(length)`) the bounded search
 * never treats as a real candidate, so the result depends only on the
 * regex's own matching behavior, not on this specific probe.
 */
export function regexHasUnresolvableShortMatchFallback(regex: RegExp): boolean {
	return ([1, 2] as const).some(length => {
		const probe = "\u0000".repeat(length);
		const savedLastIndex = regex.lastIndex;
		try {
			return findNonMatchingReplacement(probe, regex, { text: probe, start: 0, end: length }) === undefined;
		} finally {
			regex.lastIndex = savedLastIndex;
		}
	});
}
