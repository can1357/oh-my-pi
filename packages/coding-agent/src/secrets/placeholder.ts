import * as crypto from "node:crypto";
import type { SecretEntry } from "./obfuscator";
import wordList from "./words.txt" with { type: "text" };

// ═══════════════════════════════════════════════════════════════════════════
// Placeholder format
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The BIP-0039 English word list (bitcoin/bips, MIT License; Marek Palatinus,
 * Pavol Rusnak, Aaron Voisine, Sean Bowe): 2048 distinct lowercase words, so
 * each word carries 11 bits.
 */
const WORDS = wordList.trim().split("\n");
const BITS_PER_WORD = 11;
/** Words in a placeholder: 44 bits of a keyed digest, so unrelated secrets practically never share one. */
export const PLACEHOLDER_WORDS = 4;
/** Most words a 256-bit digest supplies; more are only drawn when shorter tokens collide. */
const MAX_PLACEHOLDER_WORDS = Math.floor(256 / BITS_PER_WORD);
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

/**
 * The words naming `secret`: `count` words drawn from an HMAC-SHA256 of the
 * secret under the per-install key, camelCased (`correctHorseStapleBattery`).
 * Keyed, so a low-entropy secret cannot be dictionaried from the transcript;
 * deterministic, so the same secret reads the same in every session.
 */
export function placeholderWords(key: string, secret: string, count = PLACEHOLDER_WORDS): string {
	const digest = new Bun.CryptoHasher("sha256", key).update(secret).digest();
	let words = "";
	for (let index = 0; index < Math.min(count, MAX_PLACEHOLDER_WORDS); index++) {
		let value = 0;
		for (let bit = index * BITS_PER_WORD; bit < (index + 1) * BITS_PER_WORD; bit++) {
			value = (value << 1) | ((digest[bit >> 3]! >> (7 - (bit & 7))) & 1);
		}
		const word = WORDS[value]!;
		words += index === 0 ? word : word[0]!.toUpperCase() + word.slice(1);
	}
	return words;
}

/** `$$Name_words$$`, or `$$words$$` without a friendly name. */
export function buildPlaceholder(words: string, friendlyName?: string): string {
	return friendlyName ? `$$${friendlyName}_${words}$$` : `$$${words}$$`;
}

/** Placeholder tokens; group 1 is the friendly name, group 2 the words that identify the secret. */
export const PLACEHOLDER_RE = /\$\$(?:([A-Za-z0-9]+)_)?([a-z]+(?:[A-Z][a-z]+){3,})\$\$/g;

/** Normalize a friendly name into the model-visible placeholder prefix: letters and digits, case kept. */
export function sanitizeSecretFriendlyName(name: string): string | undefined {
	const sanitized = name.replace(/[^A-Za-z0-9]/g, "").slice(0, MAX_FRIENDLY_NAME_LEN);
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
 * Raw secret values plus an index of their collision-normalized forms, so
 * {@link SecretValueSet.collidesWithLabel} answers "does any member leak through
 * this label?" without re-normalizing and scanning every member per label.
 */
export class SecretValueSet extends Set<string> {
	/** Normalized value → number of raw members normalizing to it. */
	#normalized = new Map<string, number>();
	/** Normalized length → number of distinct normalized values with that length. */
	#lengths = new Map<number, number>();
	/** First MAX_FRIENDLY_NAME_LEN chars → normalized values at least that long (display-cap prefix leaks). */
	#heads = new Map<string, Set<string>>();

	constructor(values?: Iterable<string>) {
		// Populate after super(): `Set`'s iterable constructor would call `add`
		// before this subclass's private fields exist.
		super();
		if (values) for (const value of values) this.add(value);
	}

	override add(value: string): this {
		if (super.has(value)) return this;
		super.add(value);
		const normalized = sanitizeForCollisionCheck(value);
		if (normalized.length === 0) return this;
		const count = this.#normalized.get(normalized) ?? 0;
		this.#normalized.set(normalized, count + 1);
		if (count > 0) return this;
		this.#lengths.set(normalized.length, (this.#lengths.get(normalized.length) ?? 0) + 1);
		if (normalized.length >= MAX_FRIENDLY_NAME_LEN) {
			const head = normalized.slice(0, MAX_FRIENDLY_NAME_LEN);
			let bucket = this.#heads.get(head);
			if (bucket === undefined) {
				bucket = new Set();
				this.#heads.set(head, bucket);
			}
			bucket.add(normalized);
		}
		return this;
	}

	override delete(value: string): boolean {
		if (!super.delete(value)) return false;
		const normalized = sanitizeForCollisionCheck(value);
		if (normalized.length === 0) return true;
		const count = this.#normalized.get(normalized)!;
		if (count > 1) {
			this.#normalized.set(normalized, count - 1);
			return true;
		}
		this.#normalized.delete(normalized);
		const lengthCount = this.#lengths.get(normalized.length)!;
		if (lengthCount > 1) this.#lengths.set(normalized.length, lengthCount - 1);
		else this.#lengths.delete(normalized.length);
		if (normalized.length >= MAX_FRIENDLY_NAME_LEN) {
			const head = normalized.slice(0, MAX_FRIENDLY_NAME_LEN);
			const bucket = this.#heads.get(head)!;
			bucket.delete(normalized);
			if (bucket.size === 0) this.#heads.delete(head);
		}
		return true;
	}

	override clear(): void {
		super.clear();
		this.#normalized.clear();
		this.#lengths.clear();
		this.#heads.clear();
	}

	/** Same answer as `sanitizedLabelCollidesWithSecret(label, sanitizeForCollisionCheck(v))` for any member `v`. */
	collidesWithLabel(sanitizedLabel: string): boolean {
		if (this.#normalized.size === 0) return false;
		const labelLength = sanitizedLabel.length;
		for (const length of this.#lengths.keys()) {
			for (let start = 0; start + length <= labelLength; start++) {
				if (this.#normalized.has(sanitizedLabel.slice(start, start + length))) return true;
			}
		}
		if (labelLength < MAX_FRIENDLY_NAME_LEN) return false;
		const bucket = this.#heads.get(sanitizedLabel.slice(0, MAX_FRIENDLY_NAME_LEN));
		if (bucket === undefined) return false;
		for (const normalized of bucket) {
			if (normalized.startsWith(sanitizedLabel)) return true;
		}
		return false;
	}
}

/**
 * Whether an entry needs the persisted placeholder key: it can mint a
 * reversible placeholder, whose words are a keyed digest. Short plain obfuscate
 * entries are toned down (never placeheld), so they must NOT force key
 * creation: otherwise a `secret-placeholder.key` file is written and persisted
 * for a config that ends up with no active secrets, leaving the key readable
 * via a tool and reusable for later placeholders. Replace-mode entries never
 * need it.
 */
export function secretEntryNeedsPlaceholderKey(entry: SecretEntry): boolean {
	if ((entry.mode ?? "obfuscate") !== "obfuscate") return false;
	return entry.type === "regex" || entry.content.length >= MIN_OBFUSCATE_SECRET_LEN;
}

/** Whether any of `entries` needs the persisted placeholder key (see {@link secretEntryNeedsPlaceholderKey}). */
export function secretEntriesNeedPlaceholderKey(entries: SecretEntry[]): boolean {
	return entries.some(secretEntryNeedsPlaceholderKey);
}

const PENDING_PLACEHOLDER_SUFFIX_RE = /\$\$[A-Za-z0-9_]*$|\$$/;

// Withhold a trailing run that could be the start of a placeholder from streamed
// deltas, so a partial token is never emitted before deobfuscation can replace
// it. A lone trailing delimiter character is always buffered because it can open
// a placeholder; the final non-streamed flush re-emits it when no token follows.
export function stripPendingSecretPlaceholderSuffix(text: string): string {
	const pendingPlaceholderStart = text.match(PENDING_PLACEHOLDER_SUFFIX_RE);
	if (pendingPlaceholderStart?.index === undefined) return text;
	return text.slice(0, pendingPlaceholderStart.index);
}
