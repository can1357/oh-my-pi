import * as crypto from "node:crypto";
import type { SecretEntry } from "./obfuscator";
import { ensureDistinctReplacement, generateDeterministicReplacement, REPLACEMENT_CHARS } from "./replacement";

// ═══════════════════════════════════════════════════════════════════════════
// Placeholder format
// ═══════════════════════════════════════════════════════════════════════════

const HASH_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
// Base length is sized for ~62 bits of entropy (64 bits of a keyed digest
// rendered as 12 base36 chars) so unrelated secrets do not collide on a shared
// base. A collision would let a persisted placeholder deobfuscate to the wrong
// secret when the configured secret set or its ordering changes across sessions.
const HASH_LEN = 12;
const MAX_FRIENDLY_NAME_LEN = 32;
// Plain/regex obfuscate matches shorter than this are toned down (never placed
// behind a reversible placeholder) to avoid redacting small words/fragments.
export const MIN_OBFUSCATE_SECRET_LEN = 8;

// Per-process fallback key used when a caller does not supply a persisted
// per-install key. It is random (never shipped in source), so model-visible
// placeholders cannot be reversed by dictionary-hashing candidate secrets; it
// only forgoes cross-session token stability, which the persisted key provides.
let ephemeralPlaceholderKey: string | undefined;
export function defaultPlaceholderKey(): string {
	ephemeralPlaceholderKey ??= crypto.randomBytes(32).toString("base64url");
	return ephemeralPlaceholderKey;
}

type PlaceholderCaseHint = "U" | "L" | "C" | "M";

/** Normalize a friendly name into the model-visible placeholder prefix. */
export function sanitizeSecretFriendlyName(name: string): string | undefined {
	const sanitized = name
		.replace(/[^A-Za-z0-9]/g, "")
		.toUpperCase()
		.slice(0, MAX_FRIENDLY_NAME_LEN);
	return sanitized.length > 0 ? sanitized : undefined;
}

/**
 * Normalize a secret value into the same alnum-only, uppercased shape a
 * friendly-name label or placeholder prefix is sanitized into, so comparing a
 * raw (possibly lowercase/punctuated) secret value against already-sanitized,
 * model-visible text does not miss a case- or separator-only variant. Unlike
 * `sanitizeSecretFriendlyName` this never truncates and never signals "empty"
 * via `undefined` — callers already guard on `.length > 0` before comparing.
 */
export function sanitizeForCollisionCheck(value: string): string {
	return value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

// A label leaks a secret either by containing the whole normalized secret or,
// once it reaches the public display cap, by being the secret's visible prefix.
// Shorter names like "TOKEN" can still be intentional generic labels.
export function sanitizedLabelCollidesWithSecret(sanitizedLabel: string, sanitizedSecret: string): boolean {
	if (sanitizedSecret.length === 0) return false;
	if (sanitizedLabel.includes(sanitizedSecret)) return true;
	return sanitizedLabel.length >= MAX_FRIENDLY_NAME_LEN && sanitizedSecret.startsWith(sanitizedLabel);
}

/**
 * Whether an entry needs the persisted placeholder key: either because it can
 * produce a reversible (keyed) obfuscate-mode placeholder, or because a default
 * (no custom `replacement`) replace-mode regex can reach
 * `#generateRegexReplacement`'s key-derived idempotent fallback marker (see
 * `#generateReplacement`) when every same-length candidate re-matches a
 * pathological match-everything config (e.g. `[\s\S]{8}`). That fallback depends
 * on the persisted per-install key — not just length — to stay a fixed point
 * across a process restart; without a persisted key, a fresh install falls back
 * to a process-random key (`defaultPlaceholderKey()`), so the fallback marker
 * would churn across restarts even though the algorithm itself is stable. A
 * regex WITH a custom `replacement` never reaches that fallback (it always emits
 * the literal configured string), and a plain replace secret's replacement is
 * pure content-hash (`#generateSecretReplacement`), so neither needs the key.
 * Short plain obfuscate entries are toned down (never placeheld), so they must
 * NOT force key creation: otherwise a `secret-placeholder.key` file is written
 * and persisted for a config that ends up with no active secrets, leaving the
 * key readable via a tool and reusable for later placeholders.
 */
export function secretEntryNeedsPlaceholderKey(entry: SecretEntry): boolean {
	if ((entry.mode ?? "obfuscate") === "obfuscate") {
		if (entry.type === "regex") return true;
		return entry.content.length >= MIN_OBFUSCATE_SECRET_LEN;
	}
	return entry.type === "regex" && entry.replacement === undefined;
}

/**
 * Whether a plain replace-mode replacement string can contribute a fragment that
 * helps the replace phase reconstruct an obfuscate `content`. During obfuscate()'s
 * replace phase the output is a tiling of passthrough bytes (adversary-controlled
 * provider text) and whole replacement outputs; any contiguous occurrence of
 * `content` in that output is covered by interior replacement tiles (each a
 * substring of `content`) bordered by passthrough at the ends, where the border
 * tile may be a suffix of a replacement (forming `content`'s prefix) or a prefix
 * of a replacement (forming `content`'s suffix). An EMPTY replacement deletes its
 * trigger entirely, joining the passthrough on both sides; with adversary-chosen
 * surrounding bytes that can form any non-empty `content` across the deleted gap.
 * So a replacement can help iff it is empty, is a substring of `content`,
 * contains `content`, or shares such a border overlap.
 */
function replacementCanFormContent(replacement: string, content: string): boolean {
	if (replacement.length === 0) return content.length > 0;
	if (content.includes(replacement) || replacement.includes(content)) return true;
	const maxOverlap = Math.min(replacement.length, content.length);
	for (let k = 1; k <= maxOverlap; k++) {
		// A suffix of the replacement forms the prefix of the content (left border),
		// or a prefix of the replacement forms the suffix of the content (right border).
		if (content.startsWith(replacement.slice(replacement.length - k)) || content.endsWith(replacement.slice(0, k))) {
			return true;
		}
	}
	return false;
}

/**
 * Whether a SET of entries needs the persisted placeholder key. `obfuscate()`
 * applies plain replace-mode mappings before the plain-obfuscate pass, so a plain
 * obfuscate entry only emits a reversible (keyed) placeholder when its content can
 * still appear AFTER the replace phase. When no obfuscate entry can ever produce a
 * placeholder, the persisted key must NOT be required/created — otherwise an
 * effectively replace-only secret set still writes `secret-placeholder.key` and
 * fails startup when the agent config dir is unwritable.
 *
 * The decision models the replace phase as the obfuscator actually runs it:
 * replace mappings are content-keyed (later duplicate wins) and applied in
 * descending content-length order; for a fresh probe (no prior placeholders) that
 * phase is plain sequential substring replacement. A plain obfuscate entry needs
 * the key when its content survives that simulated phase (direct typing) OR when
 * any effective replacement can form the content via tiling — a substring,
 * wholesale superstring, or prefix/suffix border that joins with surrounding
 * passthrough bytes (see `replacementCanFormContent`). This covers direct
 * shadowing (`SECRET -> safe`), reintroduction, duplicate ordering, transitive
 * chains, and context-joined fragments uniformly. Default (omitted) replacements
 * are deterministic, length-preserving, and distinct, so a same-content shadow
 * with no other interacting replacement stays key-free.
 * Replacement outputs are themselves rewritten by every later (shorter-content)
 * replacement before the plain-obfuscate pass sees them, so a fragment that a
 * subsequent replacement erases (`AA -> SEC` then `S -> X` turns every `SEC` into
 * `XEC`) no longer forces the key. Surrounding bytes stay modeled as arbitrary
 * passthrough, so testing the surviving fragment only drops false positives and
 * never under-approximates a real key need.
 */
export function secretEntriesNeedPlaceholderKey(entries: SecretEntry[]): boolean {
	const replaceMap = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type !== "plain" || (entry.mode ?? "obfuscate") !== "replace") continue;
		replaceMap.set(
			entry.content,
			entry.replacement ?? ensureDistinctReplacement(generateDeterministicReplacement(entry.content), entry.content),
		);
	}
	const replacePhase = [...replaceMap].sort((a, b) => b[0].length - a[0].length);
	// Apply the replace phase from `start` onward. The phase runs in descending
	// content-length order, so a replacement output emitted at index i is rewritten
	// only by the later (shorter-content) replacements at i+1…; `start` 0 models a
	// value typed directly into the input.
	const applyReplacePhaseFrom = (text: string, start: number): string => {
		let result = text;
		for (let i = start; i < replacePhase.length; i++) {
			result = result.split(replacePhase[i][0]).join(replacePhase[i][1]);
		}
		return result;
	};
	return entries.some(entry => {
		if (!secretEntryNeedsPlaceholderKey(entry)) return false;
		// Regex obfuscate entries match dynamically; conservatively require the key.
		if (entry.type !== "plain") return true;
		const content = entry.content;
		if (applyReplacePhaseFrom(content, 0).includes(content)) return true;
		// Test each replacement output in the form it SURVIVES the rest of the phase,
		// so a fragment a later replacement erases no longer forces the key. The
		// content it tiles into must also survive those later replacements: if a
		// shorter-content replacement rewrites the surrounding passthrough bytes
		// (e.g. `AA -> SEC` forms `SEC`+`RET12`, then `R -> X` turns the freshly
		// formed `SECRET12` into `SECXET12`), the content can never reach the
		// obfuscate pass, so the key is not needed. Requiring content stability only
		// drops such false positives — a formation that genuinely survives is still
		// caught at the replacement index that produces it.
		return replacePhase.some(
			([, replacement], i) =>
				applyReplacePhaseFrom(content, i + 1) === content &&
				replacementCanFormContent(applyReplacePhaseFrom(replacement, i + 1), content),
		);
	});
}

// Derive the model-visible base from a KEYED digest of the secret. xxHash is
// fast and unkeyed, so a fixed-seed content hash of a low-entropy secret could
// be dictionaried from the transcript; HMAC-SHA256 under a private per-install
// key cannot, since the attacker lacks the key.
export function buildHashBase(key: string, value: string): string {
	const digest = new Bun.CryptoHasher("sha256", key).update(value).digest();
	let v = 0n;
	for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(digest[i]);
	const radix = BigInt(HASH_CHARS.length);
	let tag = "";
	for (let i = 0; i < HASH_LEN; i++) {
		tag += HASH_CHARS[Number(v % radix)];
		v /= radix;
	}
	return tag;
}

// Build a deterministic, key-derived run of REPLACEMENT_CHARS of the given
// length. Used to redact a per-chunk replace remainder to a marker that depends
// only on the per-install key and the remainder length, so a fresh obfuscator
// reproduces the identical marker (idempotent redaction across restarts) while
// the run stays unpredictable without the key (raw sentinel-shaped bytes cannot
// equal the marker, so they are still redacted rather than passed through).
export function buildKeyedReplacementRun(key: string, length: number): string {
	if (length <= 0) return "";
	const radix = REPLACEMENT_CHARS.length;
	let out = "";
	for (let block = 0; out.length < length; block++) {
		const digest = new Bun.CryptoHasher("sha256", key).update(`replace-chunk\0${length}\0${block}`).digest();
		for (let i = 0; i < digest.length && out.length < length; i++) {
			out += REPLACEMENT_CHARS[digest[i] % radix];
		}
	}
	return out;
}

export function inferCaseHint(secret: string): PlaceholderCaseHint | undefined {
	let hasCased = false;
	let hasUpper = false;
	let hasLower = false;
	let capitalized = true;
	let seenFirstCased = false;

	for (let i = 0; i < secret.length; i++) {
		const code = secret.charCodeAt(i);
		const isUpper = code >= 65 && code <= 90;
		const isLower = code >= 97 && code <= 122;
		if (!isUpper && !isLower) continue;

		hasCased = true;
		if (isUpper) {
			hasUpper = true;
			if (seenFirstCased) capitalized = false;
		} else {
			hasLower = true;
			if (!seenFirstCased) capitalized = false;
		}
		seenFirstCased = true;
	}

	if (!hasCased) return undefined;
	if (hasUpper && !hasLower) return "U";
	if (hasLower && !hasUpper) return "L";
	if (capitalized) return "C";
	return "M";
}

export function buildPlaceholder(hint: PlaceholderCaseHint | undefined, base: string, friendlyName?: string): string {
	const prefix = friendlyName ? `${friendlyName}_` : "";
	return hint ? `$$${prefix}${base}:${hint}$$` : `$$${prefix}${base}$$`;
}

/** Regex matching `$$HASH$$`, `$$HASH:U$$`, and `$$FRIENDLY_HASH(:hint)$$` placeholders. */
export const PLACEHOLDER_RE = /\$\$(?:[A-Z0-9]+_)?[A-Z0-9]{4,}(?::[ULCM])?\$\$/g;

export function resumePlaceholderScanAfterRejectedCandidate(match: RegExpExecArray): void {
	// RegExp#exec does not find overlapping matches. Restart at the rejected
	// candidate's closing delimiter, which can open an immediately adjacent placeholder.
	PLACEHOLDER_RE.lastIndex = match.index + match[0].length - 2;
}

export function placeholderWithoutFriendlyName(placeholder: string): string | undefined {
	const match = /^\$\$[A-Z0-9]+_([A-Z0-9]{4,}(?::[ULCM])?)\$\$$/.exec(placeholder);
	return match ? `$$${match[1]}$$` : undefined;
}

export function lookupFriendlyPlaceholderAlias(
	deobfuscateMap: ReadonlyMap<string, { secret: string; recursive: boolean }>,
	placeholder: string,
): { secret: string; recursive: boolean } | undefined {
	const direct = deobfuscateMap.get(placeholder);
	if (direct !== undefined) return direct;
	const unprefixed = placeholderWithoutFriendlyName(placeholder);
	return unprefixed !== undefined ? deobfuscateMap.get(unprefixed) : undefined;
}

const PENDING_PLACEHOLDER_SUFFIX_RE = /(?:\$\$(?:[A-Z0-9]+_)?[A-Z0-9]*(?::[ULCM]?)?|\$)$/;

// Withhold a trailing run that could be the start of a placeholder from streamed
// deltas, so a partial token is never emitted before deobfuscation can replace
// it. A lone trailing delimiter character is always buffered because it can open
// a placeholder; the final non-streamed flush re-emits it when no token follows.
export function stripPendingSecretPlaceholderSuffix(text: string): string {
	const pendingPlaceholderStart = text.match(PENDING_PLACEHOLDER_SUFFIX_RE);
	if (pendingPlaceholderStart?.index === undefined) return text;
	return text.slice(0, pendingPlaceholderStart.index);
}

export interface RegexScanSegment {
	scanStart: number;
	scanEnd: number;
	textStart: number;
	textEnd: number;
	generatedPlaceholder: boolean;
	recursive: boolean;
}

export interface ReplaceRegexScan {
	text: string;
	segments: RegexScanSegment[];
}
