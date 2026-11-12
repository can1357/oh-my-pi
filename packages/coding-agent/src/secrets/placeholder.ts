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

/** `Name_words`, or bare `words` without a friendly name. */
export function buildPlaceholder(words: string, friendlyName?: string): string {
	return friendlyName ? `${friendlyName}_${words}` : words;
}

/**
 * Runs of four or more camelCased words bounded by non-alphanumerics (`_`
 * included, so `Name_words` yields the words). A placeholder's words; its
 * friendly name, if any, is the `Name_` right before them. Decoding only
 * replaces words this codec minted, so ordinary camelCase never restores.
 */
export const PLACEHOLDER_WORDS_RE = /(?<![A-Za-z0-9])[a-z]+(?:[A-Z][a-z]+){3,}(?![A-Za-z0-9])/g;

/** Normalize a friendly name into the model-visible placeholder prefix: letters and digits, case kept. */
export function sanitizeSecretFriendlyName(name: string): string | undefined {
	const sanitized = name.replace(/[^A-Za-z0-9]/g, "").slice(0, MAX_FRIENDLY_NAME_LEN);
	return sanitized.length > 0 ? sanitized : undefined;
}

/**
 * Whether a friendly name would show its own secret: compared as letters and
 * digits, ignoring case, the label contains the secret or, at the display
 * cap, is its prefix. Catches a secret pasted into its own label; short
 * generic names like "TOKEN" stay.
 */
export function labelShowsSecret(friendlyName: string, secret: string): boolean {
	const label = friendlyName.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
	const value = secret.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
	if (value.length === 0) return false;
	if (label.includes(value)) return true;
	return label.length >= MAX_FRIENDLY_NAME_LEN && value.startsWith(label.slice(0, MAX_FRIENDLY_NAME_LEN));
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
