#!/usr/bin/env bun

/**
 * Rewrite the natural-language prose of a prompt file into the terse
 * implementation-scratchpad voice (see `rewrite-system-prompt.style.md`),
 * leaving every structural token byte-exact.
 *
 * The file is processed line by line. Lines that are blank, Markdown headings,
 * XML tags, or Handlebars directives are preserved verbatim. Prose lines have
 * their list/indent prefix and any wrapping `{{#…}}`/`{{/…}}` block tokens
 * peeled off; the remaining sentence keeps its inline code/tags/URLs/template
 * expressions visible and is sent to an LLM (Sonnet 4.5 via OpenRouter by
 * default) in small id-keyed JSON batches that run in parallel. Each response
 * is validated — every fragile token must survive — and any line whose rewrite
 * drops a token falls back to its original text.
 *
 * Usage:
 *   OPENROUTER_API_KEY=… bun scripts/rewrite-system-prompt.ts            # rewrite system prompt in place
 *   OPENROUTER_API_KEY=… bun scripts/rewrite-system-prompt.ts --all      # rewrite every prompt + rule in place
 *   OPENROUTER_API_KEY=… bun scripts/rewrite-system-prompt.ts -i a -o b  # write to a different file
 *   bun scripts/rewrite-system-prompt.ts --dry-run                       # plan only, no network
 *
 * Output is in place by default (the input is overwritten); pass -o/--output to
 * redirect a single-file run. YAML frontmatter and fenced code blocks are kept
 * byte-exact and never sent to the model.
 *
 * Flags:
 *   -i, --input <path>     source file (default: the coding-agent system prompt)
 *   -o, --output <path>    destination for a single-file run (default: in place)
 *       --all              rewrite every bundled prompt and rule (always in place)
 *       --model <id>       OpenRouter model id (default: anthropic/claude-sonnet-4.5)
 *       --base-url <url>   OpenRouter-compatible base (default: https://openrouter.ai/api/v1)
 *       --chunk <n>        prose lines per request (default: 3)
 *       --concurrency <n>  parallel requests in flight (default: 6)
 *       --retries <n>      network/parse retries per chunk (default: 2)
 *       --temperature <n>  sampling temperature (default: 0.4)
 *       --limit <n>        rewrite only the first N prose lines per file (0 = all)
 *       --dry-run          classify + chunk, print a plan, make no network calls
 */

import * as path from "node:path";
import { parseArgs } from "node:util";
import STYLE_GUIDE from "./rewrite-system-prompt.style.md" with { type: "text" };

const DEFAULT_INPUT = "packages/coding-agent/src/prompts/system/system-prompt.md";
const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/** Prompt + rule markdown globs for `--all`, repo-root anchored. */
const PROMPT_GLOBS = [
	"packages/coding-agent/src/prompts/**/*.md",
	"packages/coding-agent/src/commit/prompts/*.md",
	"packages/coding-agent/src/commit/agentic/prompts/*.md",
	"packages/coding-agent/src/autoresearch/*.md",
	"packages/coding-agent/src/discovery/builtin-rules/*.md",
	"packages/agent/src/compaction/prompts/*.md",
	"packages/ai/src/prompts/*.md",
	"packages/typescript-edit-benchmark/src/prompts/*.md",
];

/** Matches one inline token that must survive a rewrite untouched. */
const FRAGILE_RE = /\{\{[^}]*\}\}|<[^>]*>|`[^`]*`|[A-Za-z][\w+.-]*:\/\/\S+/g;

export interface ProseEntry {
	/** Index into the file's line array. */
	lineIndex: number;
	/** Leading whitespace + wrapping block tokens + list marker. */
	prefix: string;
	/** Trailing wrapping block tokens. */
	suffix: string;
	/** The rewritable sentence core (fragile tokens left visible for the model). */
	core: string;
	/** Fragile tokens (code spans, tags, URLs, template exprs) that must survive. */
	tokens: string[];
}

export interface RewritePlan {
	lines: string[];
	prose: ProseEntry[];
}

export interface RewriteItem {
	id: number;
	text: string;
	/** Fragile tokens the rewrite MUST preserve; validated before acceptance. */
	tokens: readonly string[];
}

/**
 * Rewrite a batch of fragments. Returns a map of `id` -> validated rewritten
 * text; an id absent from the map could not be rewritten (caller keeps original).
 */
export type RewriteChunk = (items: RewriteItem[]) => Promise<Map<number, string>>;

/**
 * Split a line into a verbatim `prefix`, a rewritable `core`, and a verbatim
 * `suffix`. Invariant: `prefix + core + suffix === line`.
 *
 * `prefix` absorbs leading whitespace, any leading `{{…}}` block tokens, and a
 * single list/ordered marker. `suffix` absorbs trailing `{{…}}` tokens.
 */
export function peel(line: string): { prefix: string; core: string; suffix: string } {
	let s = line;
	let suffix = "";
	for (;;) {
		const m = s.match(/(\s*\{\{[^}]*\}\}\s*)$/);
		if (!m) break;
		suffix = m[1] + suffix;
		s = s.slice(0, s.length - m[1].length);
	}
	let prefix = "";
	for (;;) {
		const m = s.match(/^(\s*\{\{[^}]*\}\}\s*)/);
		if (!m) break;
		prefix += m[1];
		s = s.slice(m[1].length);
	}
	const marker = s.match(/^(\s*(?:[-*+]\s+|\d+\.\s+))/);
	if (marker) {
		prefix += marker[1];
		s = s.slice(marker[1].length);
	}
	return { prefix, core: s, suffix };
}

/**
 * Decide whether a line is structural (kept verbatim) rather than prose.
 *
 * Verbatim when: blank, a Markdown heading or horizontal rule, or — after
 * stripping Handlebars expressions, XML tags, code spans, and URLs — it carries
 * fewer than three alphabetic words and no sentence-ending punctuation. That
 * leaves XML tags, Handlebars directives, template-data list items, and short
 * `token: label` definition rows untouched while still catching wrapped prose
 * such as `{{#has tools "read"}}- file/dir reads …{{/has}}`.
 */
export function isVerbatimLine(line: string): boolean {
	const t = line.trim();
	if (t === "") return true;
	if (/^#{1,6}\s/.test(t)) return true; // markdown heading
	if (/^[-*=_]{3,}\s*$/.test(t)) return true; // rule / heading underline
	const residue = t
		.replace(/\{\{[^}]*\}\}/g, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/[A-Za-z][\w+.-]*:\/\/\S+/g, " ");
	const words = residue.match(/[A-Za-z]{2,}/g) ?? [];
	if (words.length === 0) return true;
	const hasSentencePunct = /[.;?!]/.test(residue);
	if (words.length < 3 && !hasSentencePunct) return true;
	return false;
}

/**
 * Verify a rewritten core still carries every fragile token from the original,
 * counting multiplicity. A dropped or reworded token (`{{…}}`, code span, tag,
 * URL) fails the check so the caller can fall back to the original line.
 */
export function preservesTokens(rewritten: string, tokens: readonly string[]): boolean {
	const want = new Map<string, number>();
	for (const tok of tokens) want.set(tok, (want.get(tok) ?? 0) + 1);
	for (const [tok, n] of want) {
		if (rewritten.split(tok).length - 1 < n) return false;
	}
	return true;
}

/**
 * Mark every line that belongs to a block-level structure the rewriter must
 * keep byte-exact and never send to the model: a leading YAML frontmatter block
 * (`---` … `---` at the very top) and fenced code blocks (``` or ~~~). The
 * per-line {@link isVerbatimLine} classifier only sees one line at a time, so a
 * frontmatter `description:` field or a `// comment` inside an example would
 * otherwise read as prose and get rewritten.
 */
export function blockSkipMask(lines: readonly string[]): boolean[] {
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	const skip = new Array<boolean>(lines.length).fill(false);
	let start = 0;
	// Leading YAML frontmatter: `---` on the first line, closed by the next `---`.
	if (lines.length > 0 && lines[0].trim() === "---") {
		let close = -1;
		for (let j = 1; j < lines.length; j++) {
			if (lines[j].trim() === "---") {
				close = j;
				break;
			}
		}
		if (close >= 0) {
			for (let k = 0; k <= close; k++) skip[k] = true;
			start = close + 1;
		}
	}
	// Fenced code blocks; the closing fence must repeat the opening fence char.
	let fenceChar: string | null = null;
	for (let i = start; i < lines.length; i++) {
		const m = lines[i].trim().match(/^(```+|~~~+)/);
		if (fenceChar === null) {
			if (m) {
				fenceChar = m[1][0];
				skip[i] = true;
			}
		} else {
			skip[i] = true;
			if (m && m[1][0] === fenceChar) fenceChar = null;
		}
	}
	return skip;
}

/** Classify every line; build the rewrite plan. */
export function planRewrite(content: string): RewritePlan {
	const lines = content.split("\n");
	const skip = blockSkipMask(lines);
	const prose: ProseEntry[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (skip[i]) continue; // frontmatter / fenced code block
		const line = lines[i];
		if (isVerbatimLine(line)) continue;
		const { prefix, core, suffix } = peel(line);
		if (core.trim() === "") continue; // nothing rewritable after peeling
		const tokens = Array.from(core.matchAll(FRAGILE_RE), m => m[0]);
		prose.push({ lineIndex: i, prefix, suffix, core, tokens });
	}
	return { lines, prose };
}

/** Split a list into fixed-size groups, preserving order. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
	const groups: T[][] = [];
	const step = Math.max(1, size);
	for (let i = 0; i < items.length; i += step) groups.push(items.slice(i, i + step));
	return groups;
}

/** Run `fn` over `items` with at most `limit` concurrent calls; preserve order. */
async function mapPool<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	const results = new Array<R>(items.length);
	let next = 0;
	const width = Math.max(1, Math.min(limit, items.length));
	const workers = Array.from({ length: width }, async () => {
		for (;;) {
			const i = next++;
			if (i >= items.length) break;
			results[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return results;
}

export interface RewriteStats {
	totalLines: number;
	proseLines: number;
	attempted: number;
	changed: number;
	fallback: number;
}

export interface RewriteOptions {
	chunkSize: number;
	concurrency: number;
	limit: number;
	onProgress?: (done: number, total: number) => void;
}

/**
 * Apply `rewriteChunk` across the plan's prose lines and reassemble the file.
 *
 * `rewriteChunk` returns replacement text keyed by line index. A missing id, or
 * a rewrite that drops a fragile token, falls back to the original line — so a
 * flaky batch degrades to "unchanged," never to corruption.
 */
export async function rewriteAll(
	content: string,
	rewriteChunk: RewriteChunk,
	opts: RewriteOptions,
): Promise<{ content: string; stats: RewriteStats }> {
	const plan = planRewrite(content);
	const lines = [...plan.lines];
	const toRewrite = opts.limit > 0 ? plan.prose.slice(0, opts.limit) : plan.prose;
	const groups = chunk(toRewrite, opts.chunkSize);

	let done = 0;
	const resolved = await mapPool(groups, opts.concurrency, async group => {
		const items: RewriteItem[] = group.map(e => ({
			id: e.lineIndex,
			text: e.core,
			tokens: e.tokens,
		}));
		let map: Map<number, string>;
		try {
			map = await rewriteChunk(items);
		} catch {
			map = new Map();
		}
		const out = group.map(entry => {
			const candidate = map.get(entry.lineIndex);
			return { entry, text: candidate ?? entry.core, ok: candidate != null };
		});
		done += group.length;
		opts.onProgress?.(done, toRewrite.length);
		return out;
	});

	let changed = 0;
	let fallback = 0;
	for (const group of resolved) {
		for (const { entry, text, ok } of group) {
			const rebuilt = entry.prefix + text + entry.suffix;
			lines[entry.lineIndex] = rebuilt;
			if (!ok) fallback++;
			else if (rebuilt !== plan.lines[entry.lineIndex]) changed++;
		}
	}

	return {
		content: lines.join("\n"),
		stats: {
			totalLines: plan.lines.length,
			proseLines: plan.prose.length,
			attempted: toRewrite.length,
			changed,
			fallback,
		},
	};
}

/** Tolerantly parse the model's `{"items":[…]}` reply (strips fences, locates the object). */
export function parseItemsResponse(text: string): { id: number; text: string }[] {
	let s = text.trim();
	const fence = s.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
	if (fence) s = fence[1].trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(s);
	} catch {
		const start = s.indexOf("{");
		const end = s.lastIndexOf("}");
		if (start < 0 || end <= start) throw new Error("response is not JSON");
		parsed = JSON.parse(s.slice(start, end + 1));
	}
	const items = (parsed as { items?: unknown })?.items;
	if (!Array.isArray(items)) throw new Error("response missing items[]");
	const out: { id: number; text: string }[] = [];
	for (const it of items) {
		const id = (it as { id?: unknown })?.id;
		const value = (it as { text?: unknown })?.text;
		if (typeof id === "number" && typeof value === "string") out.push({ id, text: value });
	}
	return out;
}

interface OpenRouterOptions {
	apiKey: string;
	model: string;
	baseUrl: string;
	temperature: number;
	retries: number;
	system: string;
}

/** OpenAI-style JSON-schema response format; forces a valid `{items:[{id,text}]}` reply. */
const REWRITE_RESPONSE_FORMAT = {
	type: "json_schema",
	json_schema: {
		name: "rewrites",
		strict: true,
		schema: {
			type: "object",
			additionalProperties: false,
			properties: {
				items: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							id: { type: "integer" },
							text: { type: "string" },
						},
						required: ["id", "text"],
					},
				},
			},
			required: ["items"],
		},
	},
} as const;

/** Build a {@link RewriteChunk} backed by an OpenRouter chat-completions endpoint. */
export function makeOpenRouterRewriter(opts: OpenRouterOptions): RewriteChunk {
	return async items => {
		const result = new Map<number, string>();
		let pending = items;
		let lastErr: unknown;
		for (let attempt = 0; attempt <= opts.retries && pending.length > 0; attempt++) {
			try {
				const body = JSON.stringify({
					model: opts.model,
					temperature: opts.temperature,
					response_format: REWRITE_RESPONSE_FORMAT,
					messages: [
						{ role: "system", content: opts.system },
						{
							role: "user",
							content: JSON.stringify({ items: pending.map(p => ({ id: p.id, text: p.text })) }),
						},
					],
				});
				const res = await fetch(`${opts.baseUrl}/chat/completions`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${opts.apiKey}`,
						"Content-Type": "application/json",
						"HTTP-Referer": "https://omp.sh/",
						"X-Title": "omp",
					},
					body,
				});
				if (!res.ok) {
					throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
				}
				const data = (await res.json()) as {
					choices?: { message?: { content?: unknown } }[];
				};
				const content = data.choices?.[0]?.message?.content;
				if (typeof content !== "string") throw new Error("no message content");
				const got = new Map<number, string>();
				for (const it of parseItemsResponse(content)) got.set(it.id, it.text);
				// Keep only rewrites that preserve every fragile token; re-request the rest.
				const stillPending: RewriteItem[] = [];
				for (const p of pending) {
					const text = got.get(p.id);
					if (text != null && preservesTokens(text, p.tokens)) result.set(p.id, text);
					else stillPending.push(p);
				}
				pending = stillPending;
			} catch (err) {
				lastErr = err;
			}
			if (pending.length > 0 && attempt < opts.retries) await Bun.sleep(400 * (attempt + 1));
		}
		if (pending.length > 0) {
			console.error(
				`  ${pending.length} line(s) [${pending.map(p => p.id).join(",")}] kept original: ${String(lastErr ?? "rewrite dropped a token")}`,
			);
		}
		return result;
	};
}

interface CliOptions {
	input: string;
	output: string;
	model: string;
	baseUrl: string;
	chunkSize: number;
	concurrency: number;
	retries: number;
	temperature: number;
	limit: number;
	dryRun: boolean;
	all: boolean;
}

function parseCli(argv: string[]): CliOptions {
	const { values } = parseArgs({
		args: argv,
		options: {
			input: { type: "string", short: "i" },
			output: { type: "string", short: "o" },
			all: { type: "boolean", default: false },
			model: { type: "string", default: DEFAULT_MODEL },
			"base-url": { type: "string", default: DEFAULT_BASE_URL },
			chunk: { type: "string", default: "3" },
			concurrency: { type: "string", default: "6" },
			retries: { type: "string", default: "2" },
			temperature: { type: "string", default: "0.4" },
			limit: { type: "string", default: "0" },
			"dry-run": { type: "boolean", default: false },
		},
		allowPositionals: false,
	});
	const input = values.input ?? DEFAULT_INPUT;
	const output = values.output ?? input;
	const num = (name: string, raw: string | undefined, fallback: number): number => {
		const n = Number(raw);
		if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got ${raw}`);
		return raw === undefined ? fallback : n;
	};
	return {
		input,
		output,
		model: values.model ?? DEFAULT_MODEL,
		baseUrl: values["base-url"] ?? DEFAULT_BASE_URL,
		chunkSize: num("chunk", values.chunk, 3),
		concurrency: num("concurrency", values.concurrency, 6),
		retries: num("retries", values.retries, 2),
		temperature: num("temperature", values.temperature, 0.4),
		limit: num("limit", values.limit, 0),
		dryRun: values["dry-run"] ?? false,
		all: values.all ?? false,
	};
}

/** Resolve every bundled prompt and rule markdown file, repo-root anchored and sorted. */
async function collectPromptFiles(): Promise<string[]> {
	const root = path.resolve(import.meta.dir, "..");
	const seen = new Set<string>();
	for (const pattern of PROMPT_GLOBS) {
		for await (const rel of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
			if (rel.endsWith(".rewritten.md")) continue; // skip stale artifacts from older runs
			seen.add(path.join(root, rel));
		}
	}
	return [...seen].sort();
}

async function main(): Promise<void> {
	const opts = parseCli(process.argv.slice(2));
	const files = opts.all ? await collectPromptFiles() : [opts.input];
	if (files.length === 0) {
		console.error("No prompt files matched.");
		return;
	}

	if (opts.dryRun) {
		for (const file of files) {
			const content = await Bun.file(file).text();
			const plan = planRewrite(content);
			const groups = chunk(opts.limit > 0 ? plan.prose.slice(0, opts.limit) : plan.prose, opts.chunkSize);
			console.error(
				`${file}: ${plan.lines.length} lines, ${plan.prose.length} prose, ${plan.lines.length - plan.prose.length} verbatim, ${groups.length} chunk(s).`,
			);
		}
		console.error("Dry run: no network calls, nothing written.");
		return;
	}

	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey) {
		console.error("Error: OPENROUTER_API_KEY is not set.");
		process.exit(1);
	}

	const rewriteChunk = makeOpenRouterRewriter({
		apiKey,
		model: opts.model,
		baseUrl: opts.baseUrl,
		temperature: opts.temperature,
		retries: opts.retries,
		system: STYLE_GUIDE,
	});

	for (const file of files) {
		const output = opts.all ? file : opts.output;
		const content = await Bun.file(file).text();
		const { content: rewritten, stats } = await rewriteAll(content, rewriteChunk, {
			chunkSize: opts.chunkSize,
			concurrency: opts.concurrency,
			limit: opts.limit,
			onProgress: (done, total) => {
				if (done === total || done % 10 === 0) console.error(`  ${file}: ${done}/${total} prose lines`);
			},
		});
		await Bun.write(output, rewritten);
		console.error(
			`Wrote ${output}: ${stats.changed} changed, ${stats.fallback} fallback, ${stats.proseLines} prose / ${stats.totalLines} lines (model ${opts.model}).`,
		);
	}
}

if (import.meta.main) {
	await main();
}
