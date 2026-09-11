#!/usr/bin/env bun
import { Database } from "bun:sqlite";
/**
 * Title-generation benchmark harness.
 *
 * Samples random first-of-session messages from the local history DB, renders
 * the shipped `title-system.md` prompt, and runs every message against a matrix
 * of title models — the on-device ONNX models (LFM2.5 230M/350M, Falcon H1 90M) via
 * the tiny-title worker, plus a remote Ollama model (Llama 3.2 3B by default).
 * Each model lane runs concurrently; within a lane requests are sequential
 * because the local worker serializes generation on one pipeline.
 *
 * Results (per-sample titles + latency, plus per-model summaries) are written
 * to a timestamped JSON file so runs can be compared later.
 *
 * Usage:
 *   bun scripts/bench-title-models.ts
 *   bun scripts/bench-title-models.ts --count 30 --seed 42
 *   bun scripts/bench-title-models.ts --models lfm2.5-230m,falcon-h1-90m
 *   bun scripts/bench-title-models.ts --local-examples
 *   bun scripts/bench-title-models.ts --ollama-url http://spark.internal:11434 --ollama-models llama3.2:3b,lfm2.5:2.6b
 *   bun scripts/bench-title-models.ts --db ~/.omp/agent/history.db --out bench.json
 */
import * as os from "node:os";
import * as path from "node:path";
import { prompt } from "@oh-my-pi/pi-utils";
import titleSystemPrompt from "../src/prompts/system/title-system.md" with { type: "text" };
import { preprocessTinyMessage } from "../src/tiny/message-preproc";
import { isTinyTitleLocalModelKey } from "../src/tiny/models";
import { normalizeGeneratedTitle } from "../src/tiny/text";
import { shutdownTinyTitleClient, tinyTitleClient } from "../src/tiny/title-client";

/** A sampled prompt with the cleaned text actually fed to the models. */
interface PreparedPrompt {
	id: number;
	raw: string;
	input: string;
}

/** One title produced for one input by one model, with wall-clock latency. */
interface BenchSample {
	id: number;
	input: string;
	title: string | null;
	ms: number;
}

/** All samples for one model plus the aggregate quality/latency summary. */
interface BenchLane {
	model: string;
	transport: "local" | "ollama";
	samples: BenchSample[];
	summary: BenchSummary;
}

/** Aggregate stats for a lane; latency percentiles skip the cold first call. */
interface BenchSummary {
	count: number;
	nulls: number;
	coldMs: number;
	warmMeanMs: number;
	warmMedianMs: number;
	warmP95Ms: number;
	lengthCompliant: string;
	punctuationFree: string;
}

interface BenchConfig {
	dbPath: string;
	count: number;
	seed: number;
	localModels: string[];
	localExamples: boolean;
	ollamaUrl: string | null;
	ollamaModels: string[];
	outPath: string;
}

const DEFAULT_LOCAL_MODELS = ["lfm2.5-230m", "lfm2.5-350m", "falcon-h1-90m"];
const DEFAULT_OLLAMA_URL = "http://spark.internal:11434";
const DEFAULT_OLLAMA_MODELS = ["llama3.2:3b", "lfm2.5:2.6b"];
const MIN_INPUT_CHARS = 10;
const MAX_INPUT_CHARS = 800;

/** System prompt with examples (used for the capable Ollama model). */
const TITLE_PROMPT_WITH_EXAMPLES = prompt.render(titleSystemPrompt, { includeExamples: true });
/** Example-free prompt matching what the on-device worker ships to tiny models. */
const TITLE_PROMPT_NO_EXAMPLES = prompt.render(titleSystemPrompt, { includeExamples: false });

/** Deterministic mulberry32 PRNG so `--seed` reproduces a sample set. */
function createRng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state |= 0;
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Pick `count` distinct random first-of-session prompts within the size band. */
function sampleHistoryPrompts(dbPath: string, count: number, rng: () => number): { id: number; prompt: string }[] {
	const db = new Database(dbPath, { readonly: true });
	try {
		const rows = db
			.query(
				`WITH firsts AS (
					SELECT session_id, MIN(id) AS id FROM history
					WHERE session_id IS NOT NULL
					GROUP BY session_id
				)
				SELECT h.id AS id, h.prompt AS prompt
				FROM history h JOIN firsts ON firsts.id = h.id
				WHERE length(trim(h.prompt)) BETWEEN ? AND ?`,
			)
			.all(MIN_INPUT_CHARS, MAX_INPUT_CHARS) as { id: number; prompt: string }[];
		const seen = new Set<string>();
		const unique: { id: number; prompt: string }[] = [];
		for (const row of rows) {
			const key = row.prompt.trim();
			if (seen.has(key)) continue;
			seen.add(key);
			unique.push(row);
		}
		// Fisher–Yates with the seeded RNG, then take the first `count`.
		for (let i = unique.length - 1; i > 0; i--) {
			const j = Math.floor(rng() * (i + 1));
			[unique[i], unique[j]] = [unique[j], unique[i]];
		}
		return unique.slice(0, Math.min(count, unique.length));
	} finally {
		db.close();
	}
}

/** Run one local ONNX model over every prompt (sequential; worker is single-lane). */
async function runLocalLane(model: string, prompts: PreparedPrompt[], systemPrompt: string): Promise<BenchSample[]> {
	const samples: BenchSample[] = [];
	for (const item of prompts) {
		const started = performance.now();
		const title = await tinyTitleClient.generate(model, item.input, { systemPrompt });
		samples.push({ id: item.id, input: item.input, title, ms: performance.now() - started });
	}
	return samples;
}

/** Extract the `<title>` payload from a free-form chat completion. */
function parseChatTitle(text: string, sourceText: string): string | null {
	if (!text || /<title\s*\/>/i.test(text)) return null;
	const closed = /<title>([\s\S]*?)<\/title>/i.exec(text);
	const open = closed ? null : /<title>([\s\S]*)/i.exec(text);
	return normalizeGeneratedTitle(closed?.[1] ?? open?.[1] ?? text, sourceText);
}

/** Run one Ollama chat model over every prompt via the /api/chat endpoint. */
async function runOllamaLane(baseUrl: string, model: string, prompts: PreparedPrompt[]): Promise<BenchSample[]> {
	const samples: BenchSample[] = [];
	for (const item of prompts) {
		const started = performance.now();
		const response = await fetch(new URL("/api/chat", baseUrl), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model,
				stream: false,
				think: false,
				keep_alive: "10m",
				messages: [
					{ role: "system", content: TITLE_PROMPT_WITH_EXAMPLES },
					{ role: "user", content: `<user>\n${item.input}\n</user>` },
				],
				options: { temperature: 0, num_predict: 1024 },
			}),
		});
		if (!response.ok) throw new Error(`Ollama ${response.status}: ${await response.text()}`);
		const payload = (await response.json()) as { message?: { content?: string } };
		const raw = payload.message?.content ?? "";
		samples.push({
			id: item.id,
			input: item.input,
			title: parseChatTitle(raw, item.input),
			ms: performance.now() - started,
		});
	}
	return samples;
}

/** Fold a lane's samples into latency percentiles and title-quality ratios. */
function summarize(samples: BenchSample[]): BenchSummary {
	const warm = samples
		.slice(1)
		.map(sample => sample.ms)
		.sort((a, b) => a - b);
	const outputs = samples.filter(sample => sample.title !== null);
	const percentile = (sorted: number[], q: number): number =>
		sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
	const wordCompliant = outputs.filter(sample => {
		const words = sample.title!.trim().split(/\s+/).length;
		return words >= 3 && words <= 7;
	}).length;
	const punctuationFree = outputs.filter(sample => !/\p{P}/u.test(sample.title!)).length;
	return {
		count: samples.length,
		nulls: samples.length - outputs.length,
		coldMs: Number((samples[0]?.ms ?? 0).toFixed(1)),
		warmMeanMs: Number((warm.reduce((sum, value) => sum + value, 0) / (warm.length || 1)).toFixed(1)),
		warmMedianMs: Number(percentile(warm, 0.5).toFixed(1)),
		warmP95Ms: Number(percentile(warm, 0.95).toFixed(1)),
		lengthCompliant: `${wordCompliant}/${outputs.length}`,
		punctuationFree: `${punctuationFree}/${outputs.length}`,
	};
}

function parseArgs(argv: string[]): BenchConfig {
	const get = (flag: string): string | undefined => {
		const index = argv.indexOf(flag);
		return index >= 0 ? argv[index + 1] : undefined;
	};
	const has = (flag: string): boolean => argv.includes(flag);
	const modelsArg = get("--models");
	const ollamaModelsArg = get("--ollama-models");
	const ollamaUrlArg = get("--ollama-url");
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return {
		dbPath: (get("--db") ?? path.join(os.homedir(), ".omp/agent/history.db")).replace(/^~/, os.homedir()),
		count: Number(get("--count") ?? 20),
		seed: Number(get("--seed") ?? Date.now() & 0xffffffff),
		localModels: modelsArg
			? modelsArg
					.split(",")
					.map(model => model.trim())
					.filter(Boolean)
			: DEFAULT_LOCAL_MODELS,
		localExamples: has("--local-examples"),
		ollamaUrl: has("--no-ollama") ? null : (ollamaUrlArg ?? DEFAULT_OLLAMA_URL),
		ollamaModels: ollamaModelsArg
			? ollamaModelsArg
					.split(",")
					.map(model => model.trim())
					.filter(Boolean)
			: DEFAULT_OLLAMA_MODELS,
		outPath: get("--out") ?? path.join(os.tmpdir(), `title-bench-${stamp}.json`),
	};
}

async function main(): Promise<void> {
	const config = parseArgs(Bun.argv.slice(2));
	const rng = createRng(config.seed);
	const rows = sampleHistoryPrompts(config.dbPath, config.count, rng);
	if (rows.length === 0) throw new Error(`No history prompts found in ${config.dbPath}`);
	const prepared: PreparedPrompt[] = rows.map(row => ({
		id: row.id,
		raw: row.prompt,
		input: preprocessTinyMessage(row.prompt),
	}));

	const invalidLocal = config.localModels.filter(model => !isTinyTitleLocalModelKey(model));
	if (invalidLocal.length > 0) throw new Error(`Unknown local title model(s): ${invalidLocal.join(", ")}`);

	console.info(`Benchmarking ${rows.length} prompts (seed ${config.seed}) from ${config.dbPath}`);

	const localPrompt = config.localExamples ? TITLE_PROMPT_WITH_EXAMPLES : TITLE_PROMPT_NO_EXAMPLES;
	// Each model is its own concurrent lane; the local worker still serializes
	// its own lanes internally, but the Ollama lane genuinely runs in parallel.
	const laneTasks: Promise<BenchLane>[] = config.localModels.map(async (model): Promise<BenchLane> => {
		const samples = await runLocalLane(model, prepared, localPrompt);
		return { model, transport: "local", samples, summary: summarize(samples) };
	});
	if (config.ollamaUrl) {
		const url = config.ollamaUrl;
		for (const model of config.ollamaModels) {
			laneTasks.push(
				(async (): Promise<BenchLane> => {
					const samples = await runOllamaLane(url, model, prepared);
					return { model: `${model}@ollama`, transport: "ollama", samples, summary: summarize(samples) };
				})(),
			);
		}
	}

	const settled = await Promise.allSettled(laneTasks);
	const lanes: BenchLane[] = [];
	for (const result of settled) {
		if (result.status === "fulfilled") lanes.push(result.value);
		else
			console.error(
				`Lane failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
			);
	}

	await shutdownTinyTitleClient();

	// Prompt-centric view: each row is one input with every model's title beside it.
	const matrix = prepared.map(item => {
		const titles: Record<string, string> = {};
		for (const lane of lanes) titles[lane.model] = lane.samples.find(sample => sample.id === item.id)?.title ?? "∅";
		return { id: item.id, raw: item.raw, input: item.input, titles };
	});

	const report = {
		generatedAt: new Date().toISOString(),
		config: { ...config, prompts: prepared },
		matrix,
		lanes,
	};
	await Bun.write(config.outPath, JSON.stringify(report, null, 2));

	for (const entry of matrix) {
		console.info(`\n[#${entry.id}] ${entry.raw.replace(/\s+/g, " ").slice(0, 140)}`);
		if (entry.input !== entry.raw.trim())
			console.info(`  (cleaned) ${entry.input.replace(/\s+/g, " ").slice(0, 140)}`);
		console.table(Object.fromEntries(lanes.map(lane => [lane.model, { output: entry.titles[lane.model] }])));
	}

	console.info("\nSummary:");
	console.table(
		Object.fromEntries(
			lanes.map(lane => [
				lane.model,
				{
					cold: lane.summary.coldMs,
					warmMean: lane.summary.warmMeanMs,
					warmP95: lane.summary.warmP95Ms,
					nulls: lane.summary.nulls,
					len3to7: lane.summary.lengthCompliant,
					punctFree: lane.summary.punctuationFree,
				},
			]),
		),
	);
	console.info(`\nWrote ${config.outPath}`);
}

await main();
