#!/usr/bin/env bun

/**
 * Sync the per-install prompt paraphrase pool with the coding-agent prompts.
 *
 * The pool holds sentences and clauses (`promptFragments` in pi-ai), not
 * lines: the runtime splits rendered prompt text the same way and swaps every
 * fragment it has a variant for, wherever it renders. Editing a prompt line
 * only un-perturbs the sentences that changed until the next sync; nothing
 * has to match a rendered line byte for byte.
 *
 * A sync collects every static fragment of the model-visible prompts (`PROMPT_GLOBS`:
 * coding-agent prompts and tool descriptions, plus every native edit-mode description),
 * drops pooled fragments no prompt uses any more, and asks a model for
 * meaning-preserving rewrites of fragments that are new or have invalid
 * variants. Fragments the model cannot paraphrase are left out and retried
 * next sync. Manual entries (the opener, dividers) are literal, hand-authored,
 * and never sent to the model.
 *
 * Usage:
 *   bun scripts/gen-prompt-perturbation.ts                 # sync: prune stale, fill new
 *   bun scripts/gen-prompt-perturbation.ts --all           # regenerate every fragment
 *   bun scripts/gen-prompt-perturbation.ts --check         # validate only, report coverage
 *   bun scripts/gen-prompt-perturbation.ts --model openai-codex/gpt-5.6-terra
 *
 * Auth goes through the same auth-storage key resolver as a session (broker,
 * else agent.db, else env), so expired credentials refresh and rotate.
 */

import * as path from "node:path";
import { parseArgs } from "node:util";
import { type Api, type ApiKey, type AuthStorage, completeSimple, type Model } from "@oh-my-pi/pi-ai";
import { discoverAuthStorage } from "@oh-my-pi/pi-ai/auth-broker";
import { promptFragments } from "@oh-my-pi/pi-ai/prompts/perturbation";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";

const REPO_ROOT = path.join(import.meta.dir, "..");
const POOL_PATH = path.join(REPO_ROOT, "packages/ai/src/prompts/perturbation-pool.json.txt");
/**
 * Model-visible prompt sources, as repo-relative globs: every coding-agent prompt and tool
 * description, plus the native edit tool's per-mode descriptions (hashline, sloppy, replace, …).
 */
const PROMPT_GLOBS = ["packages/coding-agent/src/**/*.md", "crates/edit/prompts/*.md"];
/** Markdown that never reaches a model: UI preview samples. */
const NON_PROMPT = /^packages\/coding-agent\/src\/ui\//;
const DEFAULT_MODEL = "openrouter/deepseek/deepseek-v4.1-flash";
const MAX_LENGTH_DRIFT = 0.25;
/** Fragments shorter than this carry no fingerprint worth paraphrasing. */
const MIN_FRAGMENT_LENGTH = 24;
/** Longer fragments are paragraphs in disguise: costly to paraphrase, and a few short unique sentences fingerprint enough. */
const MAX_FRAGMENT_LENGTH = 100;
const MIN_FRAGMENT_WORDS = 4;
/** Paraphrases kept per fragment; two valid ones are enough to pool it. */
const VARIANT_COUNT = 4;
/** Block helpers render to nothing, so the prose on either side stands alone. */
const BLOCK_HELPER = /\{\{~?(?:[#/^!]|else\b)[^}]*\}\}/g;

interface PoolEntry {
	source: string;
	origin: string;
	variants: string[];
	manual?: boolean;
}

interface Pool {
	version: number;
	generatedWith: string;
	entries: PoolEntry[];
}

const SYSTEM_PROMPT = [
	"You are an editorial paraphraser for an agent harness.",
	"Each numbered item is one sentence or clause cut from a larger prompt.",
	"For each item, produce FOUR distinct rewrites that keep the exact same meaning, tone, and technical claims.",
	"Rules:",
	"- one line per rewrite;",
	"- add or remove no instruction;",
	"- keep every backticked code span verbatim, and keep tool names, paths, and RFC words (MUST, NEVER, SHOULD) as written;",
	"- end without trailing punctuation, as the items do;",
	"- keep each rewrite's length within 25% of the item;",
	"- never use double quotes outside code spans;",
	"- variants must differ in wording, not only punctuation.",
	"Reply with ONLY a JSON array with one entry per item; each entry is an array of four strings, in input order.",
].join("\n");

const codeSpans = (text: string): string[] => (text.match(/`[^`]*`/g) ?? []).sort();
const trailing = (text: string): string => /[.!?;:,]?$/.exec(text)?.[0] ?? "";
const rfcWords = (text: string): string[] => (text.match(/\b(?:MUST|NEVER|SHOULD|MAY|NOT|ALWAYS)\b/g) ?? []).sort();

/** Reject variants the pool contract cannot carry. */
function invalidVariant(source: string, variant: string): string | undefined {
	if (variant.length === 0) return "empty";
	if (variant === source) return "identical to source";
	if (variant.includes("\n") || variant.includes("\r")) return "multi-line";
	if (variant !== variant.trim()) return "surrounding whitespace";
	if (Math.abs(variant.length - source.length) > Math.max(10, Math.round(source.length * MAX_LENGTH_DRIFT))) {
		return "length drift";
	}
	if (codeSpans(variant).join("\0") !== codeSpans(source).join("\0")) return "code span drift";
	if (rfcWords(variant).join() !== rfcWords(source).join()) return "RFC keyword drift";
	if (trailing(variant) !== trailing(source)) return "trailing punctuation drift";
	if ((variant.match(/\*\*/g)?.length ?? 0) !== (source.match(/\*\*/g)?.length ?? 0)) return "emphasis drift";
	return undefined;
}

/** Validate the whole pool; returns human-readable problems. */
export function validatePool(pool: Pool): string[] {
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const entry of pool.entries) {
		if (entry.source.length === 0) problems.push(`${entry.origin}: empty source`);
		if (seen.has(entry.source)) problems.push(`${entry.origin}: duplicate source`);
		seen.add(entry.source);
		if (entry.variants.length === 0) problems.push(`${entry.origin}: no variants`);
		// Manual entries are hand-authored and may delete their source (an empty variant).
		if (entry.manual) continue;
		for (const variant of entry.variants) {
			const problem = invalidVariant(entry.source, variant);
			if (problem) problems.push(`${entry.origin}: ${problem}: ${JSON.stringify(variant.slice(0, 60))}`);
		}
	}
	return problems;
}

/** Whether a fragment is prose worth pooling rather than a template piece or a code listing. */
function poolable(fragment: string): boolean {
	if (fragment.length < MIN_FRAGMENT_LENGTH || fragment.length > MAX_FRAGMENT_LENGTH) return false;
	if (fragment.includes("{{") || fragment.includes("}}")) return false;
	if (fragment.split(/\s+/).length < MIN_FRAGMENT_WORDS) return false;
	const code = codeSpans(fragment).reduce((total, span) => total + span.length, 0);
	return code * 2 < fragment.length;
}

/** Every poolable fragment of the prompt sources, mapped to the first file that uses it. */
async function collectFragments(): Promise<Map<string, string>> {
	const fragments = new Map<string, string>();
	const files: string[] = [];
	for (const pattern of PROMPT_GLOBS) {
		for await (const relative of new Bun.Glob(pattern).scan({ cwd: REPO_ROOT })) {
			if (!NON_PROMPT.test(relative)) files.push(relative);
		}
	}
	for (const relative of files.sort()) {
		const text = (await Bun.file(path.join(REPO_ROOT, relative)).text()).replace(BLOCK_HELPER, "\n");
		for (const { start, end } of promptFragments(text)) {
			const fragment = text.slice(start, end);
			if (poolable(fragment) && !fragments.has(fragment)) fragments.set(fragment, relative);
		}
	}
	return fragments;
}

interface GeneratorModel {
	model: Model<Api>;
	apiKey: ApiKey;
}

async function openModel(spec: string, storage: AuthStorage): Promise<GeneratorModel> {
	const slash = spec.indexOf("/");
	if (slash <= 0) throw new Error(`--model must be <provider>/<model-id>, got "${spec}"`);
	const provider = spec.slice(0, slash);
	const model = getBundledModel(provider as GeneratedProvider, spec.slice(slash + 1));
	if (!model) throw new Error(`unknown model "${spec}" (not in bundled catalog)`);
	if (!(await storage.keys.get(provider))) {
		throw new Error(`no credentials for provider "${provider}" (check broker or run \`omp login\`)`);
	}
	return { model, apiKey: storage.keys.resolver(provider) };
}

function textOf(content: readonly unknown[]): string {
	let text = "";
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "text") continue;
		if (!("text" in block) || typeof block.text !== "string") continue;
		text += block.text;
	}
	return text;
}

function parseVariants(raw: string, expected: number): string[][] | undefined {
	const match = /\[[\s\S]*\]/.exec(raw);
	if (!match) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(match[0]);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed) || parsed.length !== expected) return undefined;
	return parsed.map(entry => (Array.isArray(entry) ? entry.map(value => normalize(String(value))) : []));
}

function normalize(value: string): string {
	return value
		.replace(/^\s*\d+[.)]\s+/, "")
		.replace(/[\s.!?;:,]+$/, "")
		.split(/\s+/)
		.filter(Boolean)
		.join(" ");
}

/** Ask the model for rewrites of `batch`; split the batch and retry what comes back unusable. */
async function regenerateBatch(batch: PoolEntry[], generator: GeneratorModel): Promise<void> {
	if (batch.length === 0) return;
	const listing = batch.map((entry, index) => `${index + 1}. ${entry.source}`).join("\n");
	const response = await completeSimple(
		generator.model,
		{
			systemPrompt: [SYSTEM_PROMPT],
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: `Rewrite these ${batch.length} items:\n${listing}` }],
					timestamp: Date.now(),
				},
			],
		},
		{ apiKey: generator.apiKey, temperature: 1.0, disableReasoning: true, maxTokens: 65_536 },
	);
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(`model failed: ${response.errorMessage ?? response.stopReason}`);
	}
	const variants = parseVariants(textOf(response.content), batch.length);
	const failed: PoolEntry[] = [];
	batch.forEach((entry, index) => {
		const kept = [...new Set(variants?.[index] ?? [])].filter(
			variant => invalidVariant(entry.source, variant) === undefined,
		);
		if (kept.length < 2) failed.push(entry);
		else entry.variants = kept.slice(0, VARIANT_COUNT);
	});
	if (failed.length === 0) {
		console.log(`  batch of ${batch.length}: ok`);
		return;
	}
	if (batch.length === 1) {
		console.warn(`  ${batch[0].origin}: no usable variants for ${JSON.stringify(batch[0].source.slice(0, 60))}`);
		return;
	}
	const mid = Math.ceil(failed.length / 2);
	await generateSafely(failed.slice(0, mid), generator);
	await generateSafely(failed.slice(mid), generator);
}

async function generateSafely(batch: PoolEntry[], generator: GeneratorModel): Promise<void> {
	try {
		await regenerateBatch(batch, generator);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (batch.length === 1) {
			console.warn(`  ${batch[0].origin}: ${message}`);
			return;
		}
		console.warn(`batch of ${batch.length} failed (${message}); retrying in halves`);
		const mid = Math.ceil(batch.length / 2);
		await generateSafely(batch.slice(0, mid), generator);
		await generateSafely(batch.slice(mid), generator);
	}
}

async function regenerate(
	entries: PoolEntry[],
	generator: GeneratorModel,
	batchSize: number,
	concurrency: number,
): Promise<void> {
	const batches: PoolEntry[][] = [];
	for (let start = 0; start < entries.length; start += batchSize)
		batches.push(entries.slice(start, start + batchSize));
	for (let start = 0; start < batches.length; start += concurrency) {
		await Promise.all(batches.slice(start, start + concurrency).map(batch => generateSafely(batch, generator)));
	}
}

async function run(): Promise<void> {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			check: { type: "boolean", default: false },
			all: { type: "boolean", default: false },
			batch: { type: "string", default: "100" },
			limit: { type: "string", default: "0" },
			concurrency: { type: "string", default: "8" },
			only: { type: "string", default: "" },
			model: { type: "string", default: DEFAULT_MODEL },
		},
	});
	const pool = (await Bun.file(POOL_PATH).json()) as Pool;
	const fragments = await collectFragments();
	const manual = pool.entries.filter(entry => entry.manual);
	const pooled = new Map(pool.entries.filter(entry => !entry.manual).map(entry => [entry.source, entry]));
	const stale = [...pooled.keys()].filter(source => !fragments.has(source));
	const missing = [...fragments.keys()].filter(source => !pooled.has(source));

	if (values.check) {
		const problems = validatePool(pool);
		for (const problem of problems) console.error(`  ${problem}`);
		console.log(
			`Pool: ${pool.entries.length} entries, ${problems.length} problem(s); ` +
				`${fragments.size - missing.length}/${fragments.size} prompt fragments pooled, ${stale.length} stale.`,
		);
		if (problems.length > 0) process.exitCode = 1;
		return;
	}

	// Rebuild in prompt order: manual entries, then one entry per live fragment.
	const entries: PoolEntry[] = [...manual];
	for (const [source, origin] of fragments) {
		const existing = pooled.get(source);
		entries.push(existing ? { ...existing, origin } : { source, origin, variants: [] });
	}
	const targets = entries.filter(
		entry =>
			!entry.manual &&
			(values.all ||
				entry.variants.length < 2 ||
				entry.variants.some(variant => invalidVariant(entry.source, variant) !== undefined)),
	);
	const limit = Number(values.limit) || 0;
	const pending = targets
		.filter(entry => values.only === "" || entry.source.includes(values.only))
		.slice(0, limit > 0 ? limit : undefined);
	console.log(`Pruned ${stale.length} stale fragments; ${missing.length} new.`);

	if (pending.length > 0) {
		const storage = await discoverAuthStorage();
		try {
			const generator = await openModel(values.model, storage);
			console.log(`Regenerating ${pending.length} fragments with ${values.model}...`);
			await regenerate(
				pending,
				generator,
				Math.max(1, Number(values.batch) || 100),
				Math.max(1, Number(values.concurrency) || 8),
			);
			pool.generatedWith = values.model;
		} finally {
			storage.close();
		}
	}

	// Whatever still lacks variants stays unperturbed and is retried next sync.
	pool.entries = entries.filter(
		entry =>
			entry.manual ||
			(entry.variants.length > 0 &&
				entry.variants.every(variant => invalidVariant(entry.source, variant) === undefined)),
	);
	const skipped = entries.length - pool.entries.length;
	if (skipped > 0) console.log(`Left ${skipped} fragments unperturbed (no valid variants).`);
	const problems = validatePool(pool);
	if (problems.length > 0) {
		console.error("Refusing to write an invalid pool:");
		for (const problem of problems) console.error(`  ${problem}`);
		process.exitCode = 1;
		return;
	}
	await Bun.write(POOL_PATH, `${JSON.stringify(pool, null, "\t")}\n`);
	console.log(`Wrote ${POOL_PATH} (${pool.entries.length} entries).`);
}

if (import.meta.main) {
	run().catch(error => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
