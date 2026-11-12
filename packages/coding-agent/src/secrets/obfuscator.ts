import { SecretScanner } from "@oh-my-pi/pi-natives";
import { deepWalkStrings } from "./json-strings";
import {
	buildPlaceholder,
	defaultPlaceholderKey,
	labelShowsSecret,
	MIN_OBFUSCATE_SECRET_LEN,
	PLACEHOLDER_WORDS,
	PLACEHOLDER_WORDS_RE,
	placeholderWords,
	sanitizeSecretFriendlyName,
} from "./placeholder";
import { compileSecretRegex, type SecretPattern } from "./regex";
import { ensureDistinctReplacement, generateDeterministicReplacement } from "./replacement";

export interface SecretEntry {
	type: "plain" | "regex";
	/** A literal secret, or for `regex` a Rust `regex` pattern (see `compileSecretRegex`). */
	content: string;
	mode?: "obfuscate" | "replace";
	replacement?: string;
	flags?: string;
	friendlyName?: string;
}

interface CompiledRegexEntry {
	regex: SecretPattern;
	mode: "obfuscate" | "replace";
	replacement?: string;
	friendlyName?: string;
}

/** The native scanner's answer for one text (`SecretObfuscator#nativeScan`). */
interface NativeScan {
	text: string;
	/** A configured literal occurs. */
	literal: boolean;
	/** Regex entries that match the text. */
	candidates: ReadonlySet<CompiledRegexEntry>;
}

/** One secret occurrence: its range and what replaces it, ranked for overlap resolution (lower wins). */
interface Span {
	start: number;
	end: number;
	replacement: string;
	rank: number;
}

const NO_CANDIDATES: ReadonlySet<CompiledRegexEntry> = new Set();

const ALNUM = /[A-Za-z0-9]/;
/** A run that could still grow into placeholder words: lowercase first word, camelCased after. */
const WORDS_PREFIX = /^[a-z]+(?:[A-Z][a-z]*)*$/;

/**
 * Encodes local plaintext for a provider and decodes provider text back.
 *
 * `obfuscate` turns configured literals and regex-rule matches into
 * placeholders (`GitHubToken_correctHorseStapleBattery`, reversible) or
 * one-way replacements. It is idempotent: rules never match inside
 * placeholders, so text the model wrote from placeholders encodes to itself.
 * `deobfuscate` turns placeholders back into secrets where a value is used
 * locally (tool execution, display). The only state is the placeholder map,
 * which every encode (or {@link learn}) of the plaintext rebuilds;
 * placeholders are a keyed digest of the secret, so they are the same in
 * every session.
 */
export class SecretObfuscator {
	readonly #regexEntries: readonly CompiledRegexEntry[];
	/** Which regex entries match a text and whether a configured literal occurs, in one native pass. */
	readonly #scanner: SecretScanner;
	/** Literal secret → replacement (a placeholder in obfuscate mode), longest first. */
	#literals: Array<[string, string]> = [];
	/** Words of every placeholder this instance minted → the secret, and the `Name_` written before the words. */
	readonly #secretByWords = new Map<string, { secret: string; prefix: string }>();
	/** Every friendly name a placeholder can carry, sanitized. */
	readonly #friendlyNames = new Set<string>();
	/** Secret → its placeholder. */
	readonly #placeholderBySecret = new Map<string, string>();
	#key: string | undefined;
	#keyProvider: (() => string) | undefined;
	readonly #hasAny: boolean;
	#obfuscating = true;

	/** Native scan of the last text asked about; dropped when the literals change. */
	#lastNativeScan: NativeScan | undefined;
	/** Whether a {@link batch} is open. */
	#inBatch = false;
	/** Native scans of the batch in progress; dropped when the literals change. */
	#batchNativeScans: Map<string, NativeScan> | undefined;
	/**
	 * Native scans of the last batch. A scan depends only on the text and the
	 * literals, so the next batch takes these instead of rescanning.
	 */
	#previousBatchNativeScans: Map<string, NativeScan> | undefined;

	constructor(entries: SecretEntry[], key: string | (() => string) = defaultPlaceholderKey()) {
		const regexEntries: CompiledRegexEntry[] = [];
		for (const entry of entries) {
			const name = entry.friendlyName === undefined ? undefined : sanitizeSecretFriendlyName(entry.friendlyName);
			if (name) this.#friendlyNames.add(name);
		}
		for (const entry of entries) {
			if (entry.type !== "regex") continue;
			regexEntries.push({
				regex: compileSecretRegex(entry.content, entry.flags),
				mode: entry.mode ?? "obfuscate",
				replacement: entry.replacement,
				friendlyName: entry.friendlyName,
			});
		}
		this.#regexEntries = regexEntries;
		this.#scanner = new SecretScanner(
			regexEntries.map(entry => ({ pattern: entry.regex.source, flags: entry.regex.flags })),
			[],
		);
		if (typeof key === "function") this.#keyProvider = key;
		else this.#setKey(key);

		const literals = new Map<string, string>();
		for (const entry of entries) {
			if (entry.type !== "plain" || entry.content.length === 0) continue;
			if ((entry.mode ?? "obfuscate") === "replace") {
				literals.set(entry.content, entry.replacement ?? this.#replacementFor(entry.content));
			} else if (entry.content.length >= MIN_OBFUSCATE_SECRET_LEN) {
				literals.set(entry.content, this.#placeholderFor(entry.content, entry.friendlyName));
			}
		}
		for (const [secret, replacement] of literals) this.#addLiteral(secret, replacement);
		this.#hasAny = regexEntries.length > 0 || literals.size > 0;
	}

	hasSecrets(): boolean {
		return this.#hasAny;
	}

	/** Whether outbound text is currently obfuscated: secrets exist and obfuscation is switched on. */
	obfuscates(): boolean {
		return this.#hasAny && this.#obfuscating;
	}

	/**
	 * Toggle outbound obfuscation. When off, {@link obfuscate} is identity, while
	 * placeholders minted earlier keep deobfuscating so prior turns stay readable.
	 */
	setObfuscating(enabled: boolean): void {
		this.#obfuscating = enabled;
	}

	/** Encode local plaintext for a provider. Placeholders already in `text` stay as they are. */
	obfuscate(text: string): string {
		if (!this.obfuscates()) return text;
		return this.#encode(text, true);
	}

	/**
	 * Mint the placeholders encoding `texts` would, without encoding: rebuilds
	 * the placeholder map from plaintext so {@link deobfuscate} can restore
	 * placeholders a model wrote in an earlier process.
	 */
	learn(texts: Iterable<string>): void {
		if (!this.#hasAny) return;
		for (const text of texts) this.#encode(text, false);
	}

	/** Restore every placeholder this instance knows; unknown ones stay as written. */
	deobfuscate(text: string): string {
		if (this.#secretByWords.size === 0) return text;
		let out = "";
		let cursor = 0;
		for (const { start, end, secret } of this.#knownPlaceholders(text)) {
			out += text.slice(cursor, start) + secret;
			cursor = end;
		}
		return cursor === 0 ? text : out + text.slice(cursor);
	}

	/**
	 * Placeholders this instance minted in `text`, in order: the minted words
	 * and, when it is right before them, the exact `Name_` minted with them.
	 * Word runs it never minted are plain text, whatever their shape.
	 */
	#knownPlaceholders(text: string): Array<{ start: number; end: number; secret: string }> {
		const found: Array<{ start: number; end: number; secret: string }> = [];
		if (this.#secretByWords.size === 0) return found;
		let cursor = 0;
		for (const match of text.matchAll(PLACEHOLDER_WORDS_RE)) {
			const known = this.#secretByWords.get(match[0]);
			if (known === undefined) continue;
			let start = match.index;
			const before = start - known.prefix.length;
			if (
				known.prefix &&
				before >= cursor &&
				text.startsWith(known.prefix, before) &&
				(before === 0 || !ALNUM.test(text[before - 1]!))
			) {
				start = before;
			}
			cursor = match.index + match[0].length;
			found.push({ start, end: cursor, secret: known.secret });
		}
		return found;
	}

	/**
	 * Where the trailing run of a streaming `text` that could still become a
	 * placeholder starts (`text.length` when none could): a lowercase
	 * camel-word prefix, or a known friendly name's `Name_` (or a prefix of
	 * it) with one. Text before it is safe to decode and show.
	 */
	pendingPlaceholderStart(text: string): number {
		const run = /[A-Za-z0-9_]*$/.exec(text)![0];
		const runStart = text.length - run.length;
		for (let at = 0; at < run.length; at = run.indexOf("_", at) + 1 || run.length) {
			const tail = run.slice(at);
			if (WORDS_PREFIX.test(tail)) return runStart + at;
			for (const name of this.#friendlyNames) {
				const head = `${name}_`;
				if (head.startsWith(tail)) return runStart + at;
				if (tail.startsWith(head) && (tail.length === head.length || WORDS_PREFIX.test(tail.slice(head.length)))) {
					return runStart + at;
				}
			}
		}
		return text.length;
	}

	/** Deep-walk an object, deobfuscating string values. */
	deobfuscateObject<T>(obj: T): T {
		if (!this.#hasAny) return obj;
		return deepWalkStrings(obj, s => this.deobfuscate(s));
	}

	/** Deep-walk an object, obfuscating all string values. */
	obfuscateObject<T>(obj: T): T {
		if (!this.#hasAny) return obj;
		return deepWalkStrings(obj, s => this.obfuscate(s));
	}

	/**
	 * A clean cut point at or after `limit`: the length of the shortest prefix
	 * of `text` that {@link obfuscate} redacts exactly as it redacts that part
	 * of the whole text. No secret occurrence straddles the cut, and every
	 * regex entry finds the same matches in the prefix as in the whole text
	 * before it, so trailing context survives. The answer is `text.length` when
	 * no shorter prefix qualifies. Mints no placeholders.
	 */
	redactionPrefixEnd(text: string, limit: number): number {
		if (limit >= text.length) return text.length;
		const full = this.#secretRanges(text);
		const key = (ranges: ReadonlyArray<readonly [number, number]>, before: number): string =>
			ranges
				.filter(([start]) => start < before)
				.map(([start, end]) => `${start}:${end}`)
				.join(",");
		let end = limit;
		for (;;) {
			for (let moved = true; moved;) {
				moved = false;
				for (const [start, spanEnd] of full) {
					if (start < end && end < spanEnd) {
						end = spanEnd;
						moved = true;
					}
				}
			}
			if (end >= text.length) return text.length;
			if (key(this.#secretRanges(text.slice(0, end)), end) === key(full, end)) return end;
			end = Math.min(text.length, end * 2);
		}
	}

	/**
	 * Run `run` as one batch, so the native scans {@link prescan} makes are
	 * reused by every later question about the same texts. The scans carry to
	 * the next batch (see `#previousBatchNativeScans`). Nested calls join the outer batch.
	 */
	batch<T>(run: () => T): T {
		if (this.#inBatch) return run();
		this.#inBatch = true;
		try {
			return run();
		} finally {
			this.#inBatch = false;
			if (this.#batchNativeScans !== undefined) this.#previousBatchNativeScans = this.#batchNativeScans;
			this.#batchNativeScans = undefined;
		}
	}

	/**
	 * Scan every text a {@link batch} is about to encode in one native call,
	 * across cores. Texts the previous batch scanned are not sent again.
	 * Outside a batch this does nothing.
	 */
	prescan(texts: readonly string[]): void {
		if (!this.#inBatch) return;
		const scans = (this.#batchNativeScans ??= new Map());
		const previous = this.#previousBatchNativeScans;
		const pending = new Set<string>();
		for (const text of texts) {
			if (scans.has(text)) continue;
			const prior = previous?.get(text);
			if (prior !== undefined) scans.set(text, prior);
			else pending.add(text);
		}
		if (pending.size === 0) return;
		const list = [...pending];
		const results = this.#scanner.scanMany(list);
		for (let i = 0; i < list.length; i++) scans.set(list[i]!, this.#toNativeScan(list[i]!, results[i] ?? null));
	}

	#encode(text: string, emit: boolean): string {
		let native = this.#nativeScan(text);
		if (!native.literal && native.candidates.size === 0) return text;
		// Minting needs the key, and the key redacts itself: resolve it before
		// looking for literals, so its own bytes in this text are covered.
		if (this.#key === undefined && [...native.candidates].some(entry => entry.mode === "obfuscate")) {
			this.#getKey();
			native = this.#nativeScan(text);
		}
		const spans = this.#spans(text, native, true);
		if (!emit || spans.length === 0) return text;
		let out = "";
		let cursor = 0;
		for (const span of spans) {
			out += text.slice(cursor, span.start) + span.replacement;
			cursor = span.end;
		}
		return out + text.slice(cursor);
	}

	/**
	 * Non-overlapping secret occurrences in `text`, by position. Literals
	 * (longest first) win over regex matches, and earlier regex entries over
	 * later ones. `mint` decides whether placeholders are minted for them.
	 *
	 * Literals are found everywhere: a placeholder never contains a configured
	 * secret, so a literal inside one is plaintext. Rules run only outside the
	 * placeholders this instance minted, which keeps encoding idempotent under
	 * rules broad enough to match placeholder words; an unknown word run is
	 * plain text and rules see it.
	 */
	#spans(text: string, native: NativeScan, mint: boolean): Span[] {
		const candidates: Span[] = [];
		if (native.literal) {
			for (const [index, [secret, replacement]] of this.#literals.entries()) {
				for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + secret.length)) {
					candidates.push({ start: at, end: at + secret.length, replacement, rank: index });
				}
			}
		}
		if (native.candidates.size > 0) {
			let cursor = 0;
			for (const { start, end } of [...this.#knownPlaceholders(text), { start: text.length, end: text.length }]) {
				if (start > cursor) this.#ruleSpans(text.slice(cursor, start), cursor, native, mint, candidates);
				cursor = end;
			}
		}
		if (candidates.length === 0) return candidates;
		candidates.sort((a, b) => a.rank - b.rank || a.start - b.start);
		const taken = new Uint8Array(text.length);
		const accepted: Span[] = [];
		for (const span of candidates) {
			let free = true;
			for (let at = span.start; at < span.end && free; at++) free = taken[at] === 0;
			if (!free) continue;
			taken.fill(1, span.start, span.end);
			accepted.push(span);
		}
		return accepted.sort((a, b) => a.start - b.start);
	}

	/** Push the regex-rule matches in `segment` (at `offset` in its text) onto `out`. */
	#ruleSpans(segment: string, offset: number, native: NativeScan, mint: boolean, out: Span[]): void {
		for (const [index, entry] of this.#regexEntries.entries()) {
			if (!native.candidates.has(entry)) continue;
			const regex = entry.regex;
			regex.lastIndex = 0;
			for (let match = regex.exec(segment); match !== null; match = regex.exec(segment)) {
				const value = match[0];
				if (value.length === 0) {
					regex.lastIndex++;
					continue;
				}
				if (entry.mode === "obfuscate" && value.length < MIN_OBFUSCATE_SECRET_LEN) continue;
				const replacement = !mint
					? ""
					: entry.mode === "obfuscate"
						? this.#placeholderFor(value, entry.friendlyName)
						: (entry.replacement ?? this.#replacementFor(value));
				out.push({
					start: offset + match.index,
					end: offset + match.index + value.length,
					replacement,
					rank: this.#literals.length + index,
				});
			}
			regex.lastIndex = 0;
		}
	}

	/** Ranges of every secret occurrence in `text`, as {@link obfuscate} would redact them. */
	#secretRanges(text: string): Array<readonly [number, number]> {
		const native = this.#nativeScan(text);
		if (!native.literal && native.candidates.size === 0) return [];
		return this.#spans(text, native, false).map(span => [span.start, span.end] as const);
	}

	/** The placeholder for `secret`, minted on first use. */
	#placeholderFor(secret: string, friendlyName: string | undefined): string {
		const known = this.#placeholderBySecret.get(secret);
		if (known !== undefined) return known;
		const key = this.#getKey();
		let words = placeholderWords(key, secret);
		// Four words leave 44 bits; on the rare clash with another secret, draw more.
		// Which secret keeps the four-word form depends on mint order, which can
		// differ across processes; at 44 bits that is accepted, not handled.
		for (let count = PLACEHOLDER_WORDS + 1; this.#secretByWords.has(words); count++) {
			words = placeholderWords(key, secret, count);
		}
		const label = friendlyName === undefined || labelShowsSecret(friendlyName, secret) ? undefined : friendlyName;
		const name = label && sanitizeSecretFriendlyName(label);
		const placeholder = buildPlaceholder(words, name);
		this.#secretByWords.set(words, { secret, prefix: name ? `${name}_` : "" });
		this.#placeholderBySecret.set(secret, placeholder);
		return placeholder;
	}

	/** One-way replacement for a configured value or a regex match without a custom replacement. */
	#replacementFor(secret: string): string {
		return ensureDistinctReplacement(generateDeterministicReplacement(secret), secret);
	}

	#getKey(): string {
		if (this.#key !== undefined) return this.#key;
		const key = this.#keyProvider?.() ?? defaultPlaceholderKey();
		this.#keyProvider = undefined;
		this.#setKey(key);
		return key;
	}

	/**
	 * The key makes placeholders un-dictionaryable, but it can be persisted in a
	 * user-readable file. A tool read could otherwise send it to the provider, so
	 * it is redacted from outbound text as a one-way secret.
	 */
	#setKey(key: string): void {
		this.#key = key;
		this.#addLiteral(key, this.#replacementFor(key));
	}

	#addLiteral(secret: string, replacement: string): void {
		if (this.#literals.some(([known]) => known === secret)) return;
		this.#literals.push([secret, replacement]);
		this.#literals.sort((a, b) => b[0].length - a[0].length);
		this.#scanner.setLiterals(this.#literals.map(([literal]) => literal));
		this.#lastNativeScan = undefined;
		this.#batchNativeScans = undefined;
		this.#previousBatchNativeScans = undefined;
	}

	#toNativeScan(text: string, hits: { literal: boolean; rules: number[] } | null): NativeScan {
		const candidates =
			hits === null || hits.rules.length === 0
				? NO_CANDIDATES
				: new Set(hits.rules.map(index => this.#regexEntries[index]!));
		return { text, literal: hits?.literal ?? false, candidates };
	}

	/**
	 * The native scanner's literal hit and matching entries for `text`. Texts
	 * scanned in this batch or the previous one, and the last text asked about,
	 * are answered without another native call.
	 */
	#nativeScan(text: string): NativeScan {
		const last = this.#lastNativeScan;
		if (last !== undefined && last.text === text) return last;
		let scan = this.#batchNativeScans?.get(text) ?? this.#previousBatchNativeScans?.get(text);
		if (scan === undefined) {
			scan = this.#toNativeScan(text, this.#scanner.scan(text));
			if (this.#inBatch) (this.#batchNativeScans ??= new Map()).set(text, scan);
		}
		this.#lastNativeScan = scan;
		return scan;
	}
}
