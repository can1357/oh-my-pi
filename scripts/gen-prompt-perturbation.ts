#!/usr/bin/env bun

/**
 * Regenerate the per-install prompt paraphrase pool.
 *
 * Reads `packages/ai/src/prompts/perturbation-pool.json.txt`, asks a model for
 * three meaning-preserving rewrites of every non-manual `source`, validates
 * them (one line, no template syntax, close in length), and writes the pool
 * back. Manual entries (dividers) are never sent to the model.
 *
 * `--seed` first adds every static line of `packages/coding-agent/src/prompts`
 * (no Handlebars placeholders) as a pool entry, so each install paraphrases
 * the whole prompt rather than a hand-picked subset.
 *
 * Usage:
 *   bun scripts/gen-prompt-perturbation.ts                 # rewrite the pool
 *   bun scripts/gen-prompt-perturbation.ts --seed           # add every prompt line, then rewrite
 *   bun scripts/gen-prompt-perturbation.ts --check         # validate only
 *   bun scripts/gen-prompt-perturbation.ts --model openai-codex/gpt-5.6-terra
 *
 * Auth goes through the same auth-storage key resolver as a session (broker,
 * else agent.db, else env), so expired credentials refresh and rotate.
 */

import * as path from "node:path";
import { parseArgs } from "node:util";
import { type Api, type ApiKey, type AuthStorage, completeSimple, type Model } from "@oh-my-pi/pi-ai";
import { discoverAuthStorage } from "@oh-my-pi/pi-ai/auth-broker";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";

const REPO_ROOT = path.join(import.meta.dir, "..");
const POOL_PATH = path.join(REPO_ROOT, "packages/ai/src/prompts/perturbation-pool.json.txt");
const DEFAULT_MODEL = "openrouter/deepseek/deepseek-v4.1-flash";
const MAX_LENGTH_DRIFT = 0.2;
const PROMPTS_DIR = path.join(REPO_ROOT, "packages/coding-agent/src/prompts");
/** Lines shorter than this carry no fingerprint worth paraphrasing. */
const MIN_SEED_LENGTH = 40;
/** Paraphrases requested per source; any two are enough for the pool. */
const VARIANT_COUNT = 4;

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
	"For each numbered source line, produce FOUR distinct rewrites that keep the exact same meaning, tone, and technical claims.",
	"Rules:",
	"- one line per rewrite;",
	"- add or remove no instruction;",
	"- preserve every backticked code span, tool name, path, and meaning-carrying punctuation;",
	"- keep each rewrite's length within 20% of the source;",
	"- never use double quotes;",
	"- variants must differ in wording, not only punctuation.",
	"Reply with ONLY a JSON array with one entry per source; each entry is an array of four strings, in input order.",
].join("\n");

/** Reject variants the pool contract cannot carry. */
function invalidVariant(source: string, variant: string): string | undefined {
	if (variant.length === 0) return "empty";
	if (variant === source) return "identical to source";
	if (/^\s*/.exec(variant)?.[0] !== /^\s*/.exec(source)?.[0]) return "indentation drift";
	const structure = /^(#{1,6} |[-*+] |> |\d+[.)] |\|)/.exec(source)?.[0];
	if (structure !== undefined && !variant.trimStart().startsWith(structure)) return "markdown structure drift";
	if (variant.includes("\n") || variant.includes("\r")) return "multi-line";
	if (Math.abs(variant.length - source.length) > Math.max(10, Math.round(source.length * MAX_LENGTH_DRIFT))) {
		return "length drift";
	}
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
		.replace(/^\s*\d+[.)]\s*/, "")
		.split(/\s+/)
		.filter(Boolean)
		.join(" ");
}

/** Ask the model for rewrites of `entries` and keep only variants that validate. */
/** Add every static prompt line missing from the pool; returns the added entries. */
async function seed(pool: Pool): Promise<PoolEntry[]> {
	const known = new Set(pool.entries.map(entry => entry.source));
	const byTrim = new Map(pool.entries.map(entry => [entry.source.trim(), entry]));
	const added: PoolEntry[] = [];
	const glob = new Bun.Glob("**/*.md");
	for await (const relative of glob.scan({ cwd: PROMPTS_DIR })) {
		const text = await Bun.file(path.join(PROMPTS_DIR, relative)).text();
		let fenced = false;
		for (const raw of text.split("\n")) {
			if (raw.trimStart().startsWith("```")) {
				fenced = !fenced;
				continue;
			}
			const source = raw.trimEnd();
			const trimmed = source.trim();
			// Fenced code reads worse paraphrased; prose is where fingerprints live.
			if (fenced) {
				const existing = byTrim.get(trimmed);
				if (existing && !existing.manual) {
					pool.entries = pool.entries.filter(entry => entry !== existing);
					byTrim.delete(trimmed);
				}
				continue;
			}
			if (trimmed.length < MIN_SEED_LENGTH || source.includes("{{")) continue;
			const existing = byTrim.get(trimmed);
			// Manual entries own their line, including ones that span its line break.
			if (existing?.source === source || existing?.manual) continue;
			// A trimmed entry cannot match an indented rendered line; replace it with the verbatim one.
			if (existing) {
				pool.entries = pool.entries.filter(entry => entry !== existing);
				byTrim.delete(trimmed);
			} else if (known.has(source)) continue;
			known.add(source);
			const entry: PoolEntry = { source, origin: relative, variants: [] };
			byTrim.set(trimmed, entry);
			added.push(entry);
		}
	}
	pool.entries.push(...added);
	return added;
}

/** Reapply a source's indentation and list numbering to a raw variant. */
function alignVariant(entry: PoolEntry, variant: string): string {
	const indent = /^\s*/.exec(entry.source)?.[0] ?? "";
	const numbering = /^(\d+[.)] )/.exec(entry.source.trimStart())?.[0];
	const body = variant.trimStart().replace(/^\d+[.)] /, "");
	return indent + (numbering !== undefined && !body.startsWith(numbering) ? numbering : "") + body;
}

/** Ask the model for rewrites of `batch`; split the batch and retry when the reply is unusable. */
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
					content: [{ type: "text", text: `Rewrite these ${batch.length} lines:\n${listing}` }],
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
	if (!variants) {
		if (batch.length === 1) {
			console.warn(`  ${batch[0].origin}: unparseable reply, left unchanged`);
			return;
		}
		const mid = Math.ceil(batch.length / 2);
		await regenerateBatch(batch.slice(0, mid), generator);
		await regenerateBatch(batch.slice(mid), generator);
		return;
	}
	const failed: PoolEntry[] = [];
	batch.forEach((entry, index) => {
		const kept = [...new Set(variants[index].map(variant => alignVariant(entry, variant)))].filter(
			variant => invalidVariant(entry.source, variant) === undefined,
		);
		if (kept.length < 2) {
			failed.push(entry);
			return;
		}
		entry.variants = kept.slice(0, VARIANT_COUNT);
	});
	if (failed.length > 0) {
		if (batch.length > 1) {
			const mid = Math.ceil(failed.length / 2);
			await regenerateBatch(failed.slice(0, mid), generator);
			await regenerateBatch(failed.slice(mid), generator);
			return;
		}
		const source = batch[0].source;
		const kept = [...new Set(variants[0].map(variant => alignVariant(batch[0], variant)))].filter(
			variant => invalidVariant(source, variant) === undefined,
		);
		// Code-shaped lines resist paraphrase; whitespace that is free in the target syntax still defeats a byte match.
		const mechanical = [source.replaceAll(" → ", " -> "), source.replaceAll('":', '": '), `${source} `].filter(
			variant => invalidVariant(source, variant) === undefined,
		);
		const merged = [...new Set([...kept, ...mechanical])];
		if (merged.length === 0) {
			const reasons = [...new Set(variants[0].map(variant => invalidVariant(source, variant)))]
				.filter(Boolean)
				.join(", ");
			console.warn(`  ${batch[0].origin}: only 0 valid variants (${reasons}), left unchanged`);
			return;
		}
		batch[0].variants = merged.slice(0, VARIANT_COUNT);
		return;
	}
	console.log(`  batch of ${batch.length}: ok`);
}

async function generateSafely(batch: PoolEntry[], generator: GeneratorModel): Promise<void> {
	try {
		await regenerateBatch(batch, generator);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (batch.length === 1) {
			console.warn(`  ${batch[0].origin}: ${message}, left unchanged`);
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
			seed: { type: "boolean", default: false },
			batch: { type: "string", default: "100" },
			limit: { type: "string", default: "0" },
			concurrency: { type: "string", default: "8" },
			repair: { type: "boolean", default: false },
			only: { type: "string", default: "" },
			model: { type: "string", default: DEFAULT_MODEL },
		},
	});
	const pool = (await Bun.file(POOL_PATH).json()) as Pool;
	const seeded = values.seed ? await seed(pool) : [];
	console.log(`Seeded ${seeded.length} prompt lines.`);
	if (!values.seed) {
		const problems = validatePool(pool);
		if (problems.length > 0) {
			console.error(`Pool has ${problems.length} problem(s):`);
			for (const problem of problems) console.error(`  ${problem}`);
			process.exitCode = 1;
			return;
		}
	}
	if (values.check && !values.seed) {
		console.log(
			`Pool OK: ${pool.entries.length} entries, ${pool.entries.reduce((n, e) => n + e.variants.length, 0)} variants.`,
		);
		return;
	}

	const storage = await discoverAuthStorage();
	try {
		const generator = await openModel(values.model, storage);
		const limit = Number(values.limit) || 0;
		const targets = new Set(values.seed ? seeded : pool.entries.filter(entry => !entry.manual));
		if (values.repair) {
			for (const entry of pool.entries) {
				if (entry.manual) continue;
				if (
					entry.variants.length < 2 ||
					entry.variants.some(variant => invalidVariant(entry.source, variant) !== undefined)
				) {
					targets.add(entry);
				}
			}
		}
		const seen = new Set<string>();
		pool.entries = pool.entries.filter(entry => (seen.has(entry.source) ? false : (seen.add(entry.source), true)));
		const pending = [...targets]
			.filter(entry => values.only === "" || entry.source.includes(values.only))
			.slice(0, limit > 0 ? limit : undefined);
		console.log(`Regenerating ${pending.length} entries with ${values.model}...`);
		await regenerate(
			pending,
			generator,
			Math.max(1, Number(values.batch) || 100),
			Math.max(1, Number(values.concurrency) || 8),
		);
		if (values.seed) {
			const dropped = pool.entries.filter(entry => entry.variants.length === 0);
			pool.entries = pool.entries.filter(entry => entry.variants.length > 0);
			console.log(`Dropped ${dropped.length} lines the model could not paraphrase.`);
		}
		pool.generatedWith = values.model;
		const nextProblems = validatePool(pool);
		if (nextProblems.length > 0) {
			console.error("Refusing to write an invalid pool:");
			for (const problem of nextProblems) console.error(`  ${problem}`);
			process.exitCode = 1;
			return;
		}
		await Bun.write(POOL_PATH, `${JSON.stringify(pool)}\n`);
		console.log(`Wrote ${POOL_PATH}`);
	} finally {
		storage.close();
	}
}

if (import.meta.main) {
	run().catch(error => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
