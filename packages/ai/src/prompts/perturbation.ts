/**
 * Per-install rewrite of prompt text and tool descriptions.
 *
 * Every install picks one committed paraphrase per sentence or clause (see
 * `promptFragments`), keyed by the persisted install id, so requests from different installs do not share the
 * same prose while each install stays byte-stable (system-prompt `systemKey`
 * and provider prompt caches never churn between turns). The pool is authored
 * offline by `scripts/gen-prompt-perturbation.ts`. Its manual entry for the
 * system-prompt opener has an empty variant, so perturbed requests carry no
 * persona line.
 *
 * Rewriting is search and replace: one regex finds the first word of any
 * pooled source (or a manual literal, or a code fence to skip), a word tree
 * narrows the candidates by the second word, and a substring check confirms
 * the rest. A match counts only where `promptFragments` would cut, so a
 * pooled clause never rewrites part of a longer sentence. Results sit in an
 * LRU, since the same system prompts and tool descriptions recur on every
 * request.
 *
 * Off by default. A model opts in through the `prompt-perturbation` KDL axis
 * (see `packages/catalog/src/compat/rules/`); `OMP_PROMPT_PERTURBATION=1`
 * forces it on for every model and `OMP_PROMPT_PERTURBATION=0` forces it off.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { resolveCatalogPolicy } from "@oh-my-pi/pi-catalog/compat/catalog-policy";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { getInstallId } from "@oh-my-pi/pi-utils";
import type { Context, Tool } from "../types";
// A file asset rather than a text import, so the ~1 MiB pool stays off the JS heap until a request is first perturbed.
import poolPath from "./perturbation-pool.json.txt" with { type: "file" };

interface PerturbationEntry {
	source: string;
	variants: readonly string[];
	/** Hand-authored entry; regeneration leaves it alone. */
	manual?: boolean;
}

interface PerturbationPool {
	version: number;
	entries: readonly PerturbationEntry[];
}

/** A memoized rewrite, stamped with the latest call that returned it. */
interface Memo {
	rewritten: string;
	used: number;
}

/** A generated source past its second word. */
interface Continuation {
	/** The source from the end of its second word, trailing punctuation included. */
	rest: string;
	entry: PerturbationEntry;
	/** This install's variant, hashed when the source first matches. */
	variant?: string;
}

interface Perturbation {
	/**
	 * Where a rewrite can begin: a code-fence line (group 1, skipped to its closing fence),
	 * a manual literal, or the first word of a generated source where a fragment can open (group 2).
	 */
	scan: RegExp;
	/** Manual entries: literal text replaced wherever it occurs (the opener, dividers). */
	literals: ReadonlyMap<string, string>;
	/** The manual literals alone, longest first: swapped inside fenced code, which `scan` skips. */
	literal: RegExp | null;
	/**
	 * Generated entries, whole sentences or clauses, by first word, then by second word
	 * without trailing punctuation; each bucket lists the longest continuation first.
	 */
	sources: ReadonlyMap<string, ReadonlyMap<string, readonly Continuation[]>>;
	installId: string;
	/**
	 * Rewritten text by input: system prompts and tool descriptions repeat on every request.
	 * A hit only restamps its entry: reordering the map, as `LRUCache.get` does, costs several lookups.
	 */
	memo: Map<string, Memo>;
}

/** Distinct texts memoized, least recently used evicted first; a session renders a few dozen. */
const MEMO_LIMIT = 512;

/** Stamp of the latest memo access. */
let clock = 0;

/** The rest of a fenced code block: up to and including its closing fence line. */
const FENCE_CLOSE = /^[^\S\n]*```.*/gm;

let built = false;
let perturbation: Perturbation | null = null;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A sentence or clause of prompt prose, as a half-open `[start, end)` range of the text. */
export interface PromptFragment {
	start: number;
	end: number;
}

/** Indentation plus a heading, list, quote, or table marker: structure, never paraphrased. */
const LINE_PREFIX = /^[ \t]*(?:(?:#{1,6}|[-*+]|>|\d+[.)])[ \t]+)*\|?[ \t]*/;

/** Left out of every fragment: it stays in the text, and paraphrases never have to reproduce it. */
const TRAILING_PUNCTUATION = new Set([".", "!", "?", ";", ":", ","]);

function isSpace(char: string | undefined): boolean {
	return char === " " || char === "\t";
}

/** `e.g. foo` and `1.5 s` continue the sentence; only a non-lowercase word starts the next one. */
function startsSentence(lead: string): boolean {
	return lead === lead.toUpperCase();
}

/**
 * Split prose into sentences and clauses. Boundaries are line breaks, sentence
 * ends (`.`/`!`/`?` before a non-lowercase word), `;`, a spaced em dash, and
 * table pipes; backtick spans and brackets are never split, fenced code is never returned.
 * Trailing punctuation (`.`, `!`, `?`, `;`, `:`, `,`) stays outside the fragment.
 * The generator pools these; the runtime accepts a pooled source only where
 * this would cut (`startsFragment`, `endsFragment`), so it matches wherever the
 * same sentence renders, whatever line, indentation, or template surrounds it.
 */
export function promptFragments(text: string): PromptFragment[] {
	const fragments: PromptFragment[] = [];
	const push = (start: number, end: number): void => {
		while (start < end && isSpace(text[start])) start++;
		while (end > start && (isSpace(text[end - 1]) || TRAILING_PUNCTUATION.has(text[end - 1] ?? ""))) end--;
		if (end > start) fragments.push({ start, end });
	};
	let fenced = false;
	let lineStart = 0;
	while (lineStart <= text.length) {
		let lineEnd = text.indexOf("\n", lineStart);
		if (lineEnd === -1) lineEnd = text.length;
		const line = text.slice(lineStart, lineEnd);
		if (line.trimStart().startsWith("```")) {
			fenced = !fenced;
		} else if (!fenced) {
			let start = lineStart + (LINE_PREFIX.exec(line)?.[0].length ?? 0);
			let code = false;
			let depth = 0;
			for (let i = start; i < lineEnd; i++) {
				const char = text[i];
				if (char === "`") {
					code = !code;
					continue;
				}
				if (code) continue;
				if (char === "(" || char === "[") depth++;
				else if ((char === ")" || char === "]") && depth > 0) depth--;
				if (depth > 0) continue;
				let cut = -1;
				let resume = -1;
				if ((char === "." || char === "!" || char === "?" || char === ";") && isSpace(text[i + 1])) {
					let next = i + 1;
					while (next < lineEnd && isSpace(text[next])) next++;
					if (char === ";" || startsSentence(text[next] ?? "")) {
						cut = i + 1;
						resume = next;
					}
				} else if (char === "\u2014" && isSpace(text[i - 1]) && isSpace(text[i + 1])) {
					cut = i;
					resume = i + 1;
				} else if (char === "|") {
					cut = i;
					resume = i + 1;
				}
				if (cut === -1) continue;
				push(start, cut);
				start = resume;
				i = resume - 1;
			}
			push(start, lineEnd);
		}
		lineStart = lineEnd + 1;
	}
	return fragments;
}

function pickVariant(installId: string, entry: PerturbationEntry): string | undefined {
	const digest = createHash("sha256").update(`prompt-perturbation\u0000${installId}\u0000${entry.source}`).digest();
	return entry.variants[digest.readUInt32BE(0) % entry.variants.length];
}

/** Index the pool: manual literals with this install's variant, generated sources as a word tree. */
function buildPerturbation(): Perturbation | null {
	// Absolute in a source checkout or a compiled binary (`$bunfs`); relative to the bundle in the npm `dist/cli.js`.
	const poolFile =
		path.isAbsolute(poolPath) || path.win32.isAbsolute(poolPath) ? poolPath : new URL(poolPath, import.meta.url);
	const pool = JSON.parse(readFileSync(poolFile, "utf8")) as PerturbationPool;
	const installId = getInstallId();
	const literals = new Map<string, string>();
	const sources = new Map<string, Map<string, Continuation[]>>();
	for (const entry of pool.entries) {
		const { source } = entry;
		if (source.length === 0 || entry.variants.length === 0) continue;
		if (entry.manual) {
			const variant = pickVariant(installId, entry);
			if (variant !== undefined) literals.set(source, variant);
			continue;
		}
		// The generator pools clauses of four or more words; the tree keys on the first two.
		const first = source.indexOf(" ");
		if (first === -1) continue;
		const second = wordEnd(source, first + 1);
		const root = source.slice(0, first);
		let level = sources.get(root);
		if (level === undefined) {
			level = new Map();
			sources.set(root, level);
		}
		const key = source.slice(first + 1, second);
		let bucket = level.get(key);
		if (bucket === undefined) {
			bucket = [];
			level.set(key, bucket);
		}
		bucket.push({ rest: source.slice(second), entry });
	}
	if (literals.size === 0 && sources.size === 0) return null;
	for (const level of sources.values()) {
		for (const bucket of level.values()) bucket.sort((a, b) => b.rest.length - a.rest.length);
	}
	// Longest first so a literal that contains another literal is matched whole.
	const literalAlternatives = [...literals.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
	const alternatives = ["(^[^\\S\\n]*```.*)", ...literalAlternatives];
	if (sources.size > 0) {
		// Openings are a superset of where `promptFragments` cuts; `startsFragment` decides.
		const opening = `(?:${LINE_PREFIX.source}|[.!?;|\\u2014][ \\t]*)`;
		alternatives.push(`${opening}(${[...sources.keys()].map(escapeRegExp).join("|")})(?= )`);
	}
	return {
		scan: new RegExp(alternatives.join("|"), "gm"),
		literals,
		literal: literalAlternatives.length > 0 ? new RegExp(literalAlternatives.join("|"), "g") : null,
		sources,
		installId,
		memo: new Map(),
	};
}

/** Rewrite every pooled source in `text` with this install's variant. */
export function perturbPromptText(text: string): string {
	if (text.length === 0) return text;
	if (!built) {
		perturbation = buildPerturbation();
		built = true;
	}
	if (perturbation === null) return text;
	const { memo } = perturbation;
	const memoed = memo.get(text);
	if (memoed !== undefined) {
		memoed.used = ++clock;
		return memoed.rewritten;
	}
	const rewritten = rewrite(perturbation, text);
	if (memo.size >= MEMO_LIMIT) evictLeastRecent(memo);
	memo.set(text, { rewritten, used: ++clock });
	return rewritten;
}

/** Drop the entry used longest ago. A full scan, but only on a miss, which already costs a whole rewrite. */
function evictLeastRecent(memo: Map<string, Memo>): void {
	let oldest: string | undefined;
	let used = Number.POSITIVE_INFINITY;
	for (const [text, entry] of memo) {
		if (entry.used < used) {
			used = entry.used;
			oldest = text;
		}
	}
	if (oldest !== undefined) memo.delete(oldest);
}

function rewrite({ scan, literals, literal, sources, installId }: Perturbation, text: string): string {
	let out = "";
	let copied = 0;
	scan.lastIndex = 0;
	for (let match = scan.exec(text); match !== null; match = scan.exec(text)) {
		const [found, fence, root] = match;
		if (fence !== undefined) {
			FENCE_CLOSE.lastIndex = scan.lastIndex;
			// An unclosed fence runs to the end of the text.
			const close = FENCE_CLOSE.exec(text) === null ? text.length : FENCE_CLOSE.lastIndex;
			scan.lastIndex = close;
			if (literal === null) continue;
			// Fenced code is never paraphrased, but manual literals go wherever they occur.
			const code = text.slice(match.index, close);
			const swapped = code.replace(literal, value => literals.get(value) ?? value);
			if (swapped === code) continue;
			out += text.slice(copied, match.index) + swapped;
			copied = close;
			continue;
		}
		let start = match.index;
		let end = scan.lastIndex;
		let variant: string | undefined;
		if (root === undefined) {
			variant = literals.get(found);
		} else {
			// The root word ends the match, and a space follows it.
			start = end - root.length;
			const from = end + 1;
			const key = wordEnd(text, from);
			const next = sources
				.get(root)
				?.get(text.slice(from, key))
				?.find(({ rest }) => text.startsWith(rest, key) && endsFragment(text, key + rest.length));
			if (next !== undefined && startsFragment(text, start)) {
				variant = next.variant ??= pickVariant(installId, next.entry);
				end = key + next.rest.length;
			}
		}
		if (variant === undefined) continue;
		out += text.slice(copied, start) + variant;
		copied = end;
		scan.lastIndex = end;
	}
	return copied === 0 ? text : out + text.slice(copied);
}

/** End of the word at `from`, before its trailing punctuation; words break at whitespace and table pipes. */
function wordEnd(text: string, from: number): number {
	let end = from;
	while (end < text.length) {
		const code = text.charCodeAt(end);
		if (code === 0x20 || code === 0x0a || code === 0x09 || code === 0x0d || code === 0x7c) break;
		end++;
	}
	while (end > from && TRAILING_PUNCTUATION.has(text[end - 1] ?? "")) end--;
	return end;
}

/** Whether `promptFragments` could start a fragment at `start`: after a line prefix, a sentence end, `;`, a spaced em dash, or a pipe. */
function startsFragment(text: string, start: number): boolean {
	let i = start;
	while (i > 0 && isSpace(text[i - 1])) i--;
	const before = text[i - 1];
	if (before === undefined || before === "\n" || before === "|") return true;
	if (i < start) {
		if (before === ";") return true;
		if (before === "\u2014") return isSpace(text[i - 2]);
		if ((before === "." || before === "!" || before === "?") && startsSentence(text[start] ?? "")) return true;
	}
	const lineStart = text.lastIndexOf("\n", start - 1) + 1;
	return LINE_PREFIX.exec(text.slice(lineStart, start))?.[0].length === start - lineStart;
}

/** Whether `promptFragments` could end a fragment at `end`: only spaces and trailing punctuation precede a line end, sentence end, `;`, spaced em dash, or pipe. */
function endsFragment(text: string, end: number): boolean {
	for (let i = end; i < text.length; i++) {
		const char = text[i] ?? "";
		if (char === "\n" || char === "|") return true;
		if (char === "\u2014") return isSpace(text[i - 1]) && isSpace(text[i + 1]);
		if (isSpace(char)) continue;
		if (!TRAILING_PUNCTUATION.has(char)) return false;
		if (char === "," || char === ":" || !isSpace(text[i + 1])) continue;
		let next = i + 1;
		while (isSpace(text[next])) next++;
		if (char === ";" || startsSentence(text[next] ?? "")) return true;
	}
	return true;
}

function perturbTools(tools: Tool[] | undefined): Tool[] | undefined {
	if (tools === undefined) return undefined;
	let changed = false;
	const next = tools.map(tool => {
		const description = perturbPromptText(tool.description);
		if (description === tool.description) return tool;
		changed = true;
		return { ...tool, description };
	});
	return changed ? next : tools;
}

/** Whether requests to `model` are perturbed: `OMP_PROMPT_PERTURBATION` (`0`/`1`) wins over the KDL axis. */
export function isPromptPerturbationEnabled(model: Model): boolean {
	const env = process.env.OMP_PROMPT_PERTURBATION;
	if (env === "0") return false;
	if (env === "1") return true;
	return resolveCatalogPolicy(model).promptPerturbation === true;
}

/**
 * Rewrite the model-visible prose of a request to `model` when perturbation is
 * enabled for it: system-prompt blocks and every tool description, including
 * tools Anthropic may activate later.
 */
export function perturbContext(model: Model, context: Context): Context {
	if (!isPromptPerturbationEnabled(model)) return context;
	// Legacy pi-ai callers pass one string; wrap it as one block so providers that spread the array keep it whole.
	const raw: readonly string[] | string | undefined = context.systemPrompt;
	const systemPrompt = typeof raw === "string" ? [perturbPromptText(raw)] : raw?.map(perturbPromptText);
	const tools = perturbTools(context.tools);
	const inactiveTools = perturbTools(context.inactiveTools);
	if (systemPrompt === context.systemPrompt && tools === context.tools && inactiveTools === context.inactiveTools) {
		return context;
	}
	return {
		...context,
		...(systemPrompt !== context.systemPrompt && { systemPrompt }),
		...(tools !== context.tools && { tools }),
		...(inactiveTools !== context.inactiveTools && { inactiveTools }),
	};
}

/** Drop the memoized choices; tests and long-lived processes that adopt a new install id call this. */
export function resetPromptPerturbation(): void {
	built = false;
	perturbation = null;
}
