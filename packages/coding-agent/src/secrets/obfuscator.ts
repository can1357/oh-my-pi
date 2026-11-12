import { SecretScanner } from "@oh-my-pi/pi-natives";
import { deepWalkStrings } from "./json-strings";
import {
	buildPlaceholder,
	defaultPlaceholderKey,
	labelShowsSecret,
	MIN_OBFUSCATE_SECRET_LEN,
	PLACEHOLDER_RE,
	PLACEHOLDER_WORDS,
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
	/** A configured literal or `$$` occurs. */
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

/**
 * Encodes local plaintext for a provider and decodes provider text back.
 *
 * `obfuscate` runs once on content that enters the model's context from
 * outside it (user input, tool output, injected text): configured literals
 * and regex-rule matches become placeholders (`$$Name_correctHorseStapleBattery$$`,
 * reversible) or one-way replacements. Text the model wrote is already in
 * placeholder form and is never encoded again. `deobfuscate` turns
 * placeholders back into secrets where a value is used locally (tool
 * execution, display). The only state is the placeholder map, which every
 * encode (or {@link learn}) of the plaintext rebuilds; placeholders are a
 * keyed digest of the secret, so they are the same in every session.
 */
export class SecretObfuscator {
	readonly #regexEntries: readonly CompiledRegexEntry[];
	/** Which regex entries match a text and whether a configured literal occurs, in one native pass. */
	readonly #scanner: SecretScanner;
	/** Literal secret → replacement (a placeholder in obfuscate mode), longest first. */
	#literals: Array<[string, string]> = [];
	/** Words of every placeholder this instance minted → the secret. */
	readonly #secretByWords = new Map<string, string>();
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
			["$$"],
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
		if (!this.#hasAny || !text.includes("$$")) return text;
		return text.replace(PLACEHOLDER_RE, (token, _name: string | undefined, words: string) => {
			return this.#secretByWords.get(words) ?? token;
		});
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
		let out = "";
		let cursor = 0;
		for (const [start, end] of native.literal ? this.#knownPlaceholderRanges(text) : []) {
			out += this.#encodeSegment(text.slice(cursor, start), native, emit) + text.slice(start, end);
			cursor = end;
		}
		return out + this.#encodeSegment(cursor === 0 ? text : text.slice(cursor), native, emit);
	}

	/** Encode a stretch holding no known placeholder; a rule can match only within it. */
	#encodeSegment(segment: string, native: NativeScan, emit: boolean): string {
		const spans = this.#spans(segment, native, true);
		if (!emit || spans.length === 0) return segment;
		let out = "";
		let cursor = 0;
		for (const span of spans) {
			out += segment.slice(cursor, span.start) + span.replacement;
			cursor = span.end;
		}
		return out + segment.slice(cursor);
	}

	/**
	 * Non-overlapping secret occurrences in `segment`, by position. Literals
	 * (longest first) win over regex matches, and earlier regex entries over
	 * later ones. `mint` decides whether placeholders are minted for them.
	 */
	#spans(segment: string, native: NativeScan, mint: boolean): Span[] {
		const candidates: Span[] = [];
		if (native.literal) {
			for (const [index, [secret, replacement]] of this.#literals.entries()) {
				for (let at = segment.indexOf(secret); at !== -1; at = segment.indexOf(secret, at + secret.length)) {
					candidates.push({ start: at, end: at + secret.length, replacement, rank: index });
				}
			}
		}
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
				candidates.push({
					start: match.index,
					end: match.index + value.length,
					replacement,
					rank: this.#literals.length + index,
				});
			}
			regex.lastIndex = 0;
		}
		if (candidates.length === 0) return candidates;
		candidates.sort((a, b) => a.rank - b.rank || a.start - b.start);
		const taken = new Uint8Array(segment.length);
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

	/** Ranges of every secret occurrence in `text`, as {@link obfuscate} would redact them. */
	#secretRanges(text: string): Array<readonly [number, number]> {
		const native = this.#nativeScan(text);
		if (!native.literal && native.candidates.size === 0) return [];
		const ranges: Array<readonly [number, number]> = [];
		let cursor = 0;
		const add = (segment: string, offset: number): void => {
			for (const span of this.#spans(segment, native, false)) {
				ranges.push([offset + span.start, offset + span.end]);
			}
		};
		for (const [start, end] of native.literal ? this.#knownPlaceholderRanges(text) : []) {
			add(text.slice(cursor, start), cursor);
			cursor = end;
		}
		add(text.slice(cursor), cursor);
		return ranges;
	}

	/** Ranges of placeholders in `text` this instance minted. */
	#knownPlaceholderRanges(text: string): Array<readonly [number, number]> {
		if (!text.includes("$$")) return [];
		const ranges: Array<readonly [number, number]> = [];
		for (const match of text.matchAll(PLACEHOLDER_RE)) {
			if (this.#secretByWords.has(match[2]!)) ranges.push([match.index, match.index + match[0].length]);
		}
		return ranges;
	}

	/** The placeholder for `secret`, minted on first use. */
	#placeholderFor(secret: string, friendlyName: string | undefined): string {
		const known = this.#placeholderBySecret.get(secret);
		if (known !== undefined) return known;
		const key = this.#getKey();
		let words = placeholderWords(key, secret);
		// Four words leave 44 bits; on the rare clash with another secret, draw more.
		for (let count = PLACEHOLDER_WORDS + 1; this.#secretByWords.has(words); count++) {
			words = placeholderWords(key, secret, count);
		}
		const label = friendlyName === undefined || labelShowsSecret(friendlyName, secret) ? undefined : friendlyName;
		const placeholder = buildPlaceholder(words, label && sanitizeSecretFriendlyName(label));
		this.#secretByWords.set(words, secret);
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
		this.#scanner.setLiterals(["$$", ...this.#literals.map(([literal]) => literal)]);
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
