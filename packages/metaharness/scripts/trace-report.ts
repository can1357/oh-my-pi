#!/usr/bin/env bun
/**
 * Narrative trace report for a metaharness run trace.
 *
 * Two-stage map/reduce over the normalized trace JSON served by the
 * metaharness server (`GET /api/runs/:run/traces/:trace`):
 *
 *   1. Map — every assistant turn (its prose, tool calls, and full tool
 *      result bodies) is handed to a very cheap "tiny" model which returns a
 *      single grounded sentence describing what the agent did and what the
 *      results showed. Turns are independent, so this fans out in parallel.
 *   2. Reduce — the deterministic numbered Turn Log (tool names come from the
 *      trace itself, only the grounded sentence is model-written) plus run
 *      metadata, harness notices, error excerpts, and the final assistant
 *      prose go to a slightly smarter (still cheap) model which writes the
 *      Story Arc and, for failed runs, the failure analysis.
 *
 * Usage:
 *   bun scripts/trace-report.ts <run> <trace>
 *   bun scripts/trace-report.ts "<run>|<trace>"            # or run/trace
 *   ... --focus "known-correct fix is X; compare"          # reviewer notes
 *   ... --out report.md
 *   ... --tiny openrouter/inclusionai/ling-2.6-flash
 *   ... --synth openrouter/openai/gpt-oss-120b
 *
 * Auth: provider API keys resolve through omp's auth storage
 * (~/.omp/agent/agent.db: stored key, OAuth, or env var fallback).
 */

import { parseArgs } from "node:util";
import { type Api, AuthStorage, completeSimple, type Model, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";

const DEFAULT_TINY = "openrouter/inclusionai/ling-2.6-flash";
const DEFAULT_SYNTH = "openrouter/openai/gpt-oss-120b";
const DEFAULT_BASE = "http://localhost:4700";

// --------------------------------------------------------------------------
// Trace API types (mirror packages/metaharness/src/store.ts normalization)

interface TraceAssistantEntry {
	kind: "assistant";
	model: string;
	text: string;
	tools: string[];
}

interface TraceToolResultEntry {
	kind: "toolResult";
	tool: string;
	isError: boolean;
	text: string;
}

interface TraceNoticeEntry {
	kind: "notice";
	text: string;
}

type TraceEntry = TraceAssistantEntry | TraceToolResultEntry | TraceNoticeEntry;

interface TraceResponse {
	jobName: string;
	trace: string;
	entries: TraceEntry[];
	totalEvents: number;
}

interface RunTraceRow {
	name: string;
	task: string;
	status: string;
	reward: number | null;
	costUsd: number | null;
	durationMs: number | null;
}

interface RunResponse {
	run: { benchmark: string; dataset: string; models: string; jobName: string };
	traces: RunTraceRow[];
}

// --------------------------------------------------------------------------
// Turn grouping

/** One numbered item of the Turn Log: an assistant turn or a harness notice. */
type LogItem =
	| { kind: "turn"; model: string; text: string; tools: string[]; results: TraceToolResultEntry[] }
	| { kind: "notice"; text: string };

function groupItems(entries: TraceEntry[]): LogItem[] {
	const items: LogItem[] = [];
	let current: Extract<LogItem, { kind: "turn" }> | undefined;
	for (const entry of entries) {
		if (entry.kind === "assistant") {
			current = { kind: "turn", model: entry.model, text: entry.text, tools: entry.tools, results: [] };
			items.push(current);
		} else if (entry.kind === "toolResult") {
			if (!current) throw new Error("trace starts with a toolResult; cannot attach it to a turn");
			current.results.push(entry);
		} else {
			items.push({ kind: "notice", text: entry.text });
		}
	}
	return items;
}

// --------------------------------------------------------------------------
// Model + auth

interface OpenedModel {
	model: Model<Api>;
	apiKey: string;
	spec: string;
	usage: { input: number; output: number; calls: number };
}

async function openModel(modelSpec: string, storage: AuthStorage): Promise<OpenedModel> {
	const slash = modelSpec.indexOf("/");
	if (slash <= 0) throw new Error(`model must be <provider>/<model-id>, got "${modelSpec}"`);
	const provider = modelSpec.slice(0, slash);
	const modelId = modelSpec.slice(slash + 1);
	const model = getBundledModel(provider as GeneratedProvider, modelId);
	if (!model) throw new Error(`unknown model "${modelSpec}" (not in bundled catalog)`);
	const apiKey = await storage.getApiKey(provider);
	if (!apiKey) {
		throw new Error(`no credentials for provider "${provider}" (run \`omp login\` or set the provider env var)`);
	}
	return { model, apiKey, spec: modelSpec, usage: { input: 0, output: 0, calls: 0 } };
}

/** One retried oneshot text completion. Throws after `attempts` failures. */
async function ask(opened: OpenedModel, system: string, user: string, maxTokens: number): Promise<string> {
	let lastError = "";
	for (let attempt = 0; attempt < 4; attempt++) {
		const response = await completeSimple(
			opened.model,
			{
				systemPrompt: [system],
				messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }],
			},
			{ apiKey: opened.apiKey, temperature: 0, maxTokens },
		);
		opened.usage.calls++;
		opened.usage.input += response.usage.input + response.usage.cacheRead;
		opened.usage.output += response.usage.output;
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			lastError = response.errorMessage ?? response.stopReason;
			await Bun.sleep(1000 * (attempt + 1));
			continue;
		}
		const text = response.content
			.filter(content => content.type === "text")
			.map(content => content.text)
			.join("")
			.trim();
		if (text) return text;
		lastError = "model returned no text";
	}
	throw new Error(`completion failed on ${opened.spec}: ${lastError}`);
}

// --------------------------------------------------------------------------
// Map phase: one grounded sentence per assistant turn

const TINY_SYSTEM = `You annotate one turn of an AI coding-agent transcript.
Reply with exactly ONE sentence (at most 35 words). Plain text only: no markdown, no bullet, no quotes around the whole reply, no preamble. Write in third person ("The agent …").
The sentence states what the agent did this turn and what the tool results showed.
Be concrete: copy exact file paths, line numbers, function names, commands, test counts, and error messages from the material given.
Describe ONLY what this turn's tool results prove. Never claim something ran, passed, or was fixed unless a result in THIS turn shows it.
The assistant prose states the agent's intent; only tool results are evidence — never present intentions as completed actions.
Never work the agent model name into the sentence.
A todo result is a checklist snapshot: describe the checklist state (items added/completed), never narrate its items as performed actions.
A write result only proves the file was written (path and size).
An edit result shows the affected file lines AFTER the change ([path#TAG] header plus numbered lines): quote the resulting logic precisely; never guess what was removed.
Tags like #C32D in [path#TAG] headers are content hashes, not line numbers — never cite them.
If a tool result is an error, the sentence MUST name the error.
If there are no tool calls, summarize what the assistant prose states or concludes.`;

const RESULT_EXCERPT_LIMIT = 1400;

function turnPrompt(turn: Extract<LogItem, { kind: "turn" }>): string {
	const parts: string[] = [`Agent model: ${turn.model}`];
	parts.push(`Assistant prose: ${turn.text.trim() ? turn.text.trim().slice(0, 2000) : "(none)"}`);
	if (turn.results.length === 0) {
		parts.push("Tool calls: none.");
	}
	turn.results.forEach((result, index) => {
		const body =
			result.text.length > RESULT_EXCERPT_LIMIT ? `${result.text.slice(0, RESULT_EXCERPT_LIMIT)}…` : result.text;
		parts.push(`Tool call ${index + 1}: ${result.tool} → ${result.isError ? "ERROR" : "ok"}\n${body}`);
	});
	if (turn.results.length > 0 && turn.results.every(result => result.tool === "todo")) {
		parts.push(
			"NOTE: this turn only updated the todo checklist. The checklist items are PLANS, not events; your sentence must summarize only the checklist state (item counts, statuses, the in-progress item).",
		);
	}
	parts.push("One sentence:");
	return parts.join("\n\n");
}

/** Map `items` through `worker` with at most `limit` in flight, order preserved. */
async function mapPool<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	const results = new Array<R>(items.length);
	let next = 0;
	const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await worker(items[index], index);
		}
	});
	await Promise.all(lanes);
	return results;
}

// --------------------------------------------------------------------------
// Turn Log assembly (deterministic scaffolding + tiny sentences)

function toolsLine(tools: string[]): string {
	if (tools.length === 0) return "prose only (no tool calls)";
	const counts = new Map<string, number>();
	for (const tool of tools) counts.set(tool, (counts.get(tool) ?? 0) + 1);
	const named = [...counts.entries()].map(([tool, n]) => (n > 1 ? `\`${tool}\` ×${n}` : `\`${tool}\``));
	return `tools called: ${named.join(", ")}`;
}

function renderTurnLog(items: LogItem[], sentences: (string | undefined)[]): string {
	const lines: string[] = ["### Turn Log", ""];
	items.forEach((item, index) => {
		const number = index + 1;
		if (item.kind === "notice") {
			lines.push(`${number}. **— harness: notice: "${item.text}"**`);
			return;
		}
		const errored = item.results.filter(result => result.isError).map(result => `\`${result.tool}\``);
		const errorNote = errored.length > 0 ? ` (errored: ${errored.join(", ")})` : "";
		lines.push(`${number}. **[${item.model}]** ${toolsLine(item.tools)}${errorNote}.`);
		lines.push(`   - Grounded action: ${sentences[index] ?? "(summary unavailable)"}`);
	});
	return lines.join("\n");
}

// --------------------------------------------------------------------------
// Reduce phase: story arc + failure analysis

const SYNTH_SYSTEM = `You write the "Story Arc" section of a trace-analysis report for one AI coding-agent benchmark run.
You are given run metadata, a numbered Turn Log (already final — never rewrite or renumber it), the run's final assistant message, and optional reviewer focus notes.
Output ONLY a markdown "### Story Arc" section.
Rules:
- Bullets of the form: - **Turns A–B (N turns): Title (model)**: 1–3 sentence description of that phase.
- The ranges must cover every numbered Turn Log item exactly once, in order, with no gaps or overlaps; harness notices belong to the range containing them and phase boundaries should align with model switches and notices where sensible.
- Every claim must be grounded in the Turn Log or the final assistant message; never invent files, tests, or events.
- If the run status is "fail", end with a final bullet - **Failure analysis**: explaining what the agent actually changed, why the run still failed, and — when reviewer focus notes describe the known-correct fix — how the agent's change diverges from it and what verification would have caught the gap.`;

function synthPrompt(options: {
	run: string;
	trace: string;
	meta: string;
	status: string | undefined;
	focus: string | undefined;
	turnLog: string;
	finalProse: string;
}): string {
	const failed = options.status === "fail";
	const parts = [
		`Run: ${options.run}\nTrace: ${options.trace}\n${options.meta}`,
		options.focus ? `Reviewer focus notes:\n${options.focus}` : "",
		options.turnLog,
		`Final assistant message (verbatim, may be truncated):\n"""\n${options.finalProse.slice(0, 4000) || "(none)"}\n"""`,
		failed
			? 'Run status is "fail". Write the Story Arc now; the LAST bullet MUST be **Failure analysis** per the rules.'
			: "Write the Story Arc now.",
	];
	return parts.filter(Boolean).join("\n\n");
}

// --------------------------------------------------------------------------
// Run

function formatDuration(ms: number | null): string {
	if (ms == null) return "?";
	const seconds = Math.round(ms / 1000);
	return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function usageLine(opened: OpenedModel): string {
	const cost = opened.model.cost
		? (opened.usage.input * opened.model.cost.input + opened.usage.output * opened.model.cost.output) / 1e6
		: undefined;
	const costText = cost === undefined ? "" : ` ≈ $${cost.toFixed(4)}`;
	return `${opened.spec}: ${opened.usage.calls} calls, ${opened.usage.input} in / ${opened.usage.output} out tokens${costText}`;
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		args: Bun.argv.slice(2),
		allowPositionals: true,
		options: {
			base: { type: "string", default: DEFAULT_BASE },
			tiny: { type: "string", default: DEFAULT_TINY },
			synth: { type: "string", default: DEFAULT_SYNTH },
			focus: { type: "string" },
			out: { type: "string" },
			concurrency: { type: "string", default: "8" },
		},
	});

	const joined = positionals.join(" ").trim();
	const match = joined.match(/^(\S+?)[|/\s]+(\S+)$/);
	if (!match) {
		console.error('usage: bun scripts/trace-report.ts <run> <trace>   (or "<run>|<trace>")');
		process.exit(2);
	}
	const [, run, trace] = match;

	const traceResponse = await fetch(`${values.base}/api/runs/${run}/traces/${trace}`);
	if (!traceResponse.ok)
		throw new Error(`trace fetch failed: HTTP ${traceResponse.status} ${await traceResponse.text()}`);
	const traceData = (await traceResponse.json()) as TraceResponse;

	let meta = "";
	let status: string | undefined;
	try {
		const runResponse = await fetch(`${values.base}/api/runs/${run}`);
		if (runResponse.ok) {
			const runData = (await runResponse.json()) as RunResponse;
			const row = runData.traces.find(candidate => candidate.name === trace);
			status = row?.status;
			meta = [
				`Benchmark: ${runData.run.benchmark} (${runData.run.dataset})`,
				`Configured model: ${runData.run.models}`,
				row
					? `Task: ${row.task} — status: ${row.status.toUpperCase()} (reward ${row.reward ?? "?"}), cost $${row.costUsd?.toFixed(2) ?? "?"}, duration ${formatDuration(row.durationMs)}`
					: "",
			]
				.filter(Boolean)
				.join("\n");
		}
	} catch {
		// Report still works from the trace alone.
	}

	const items = groupItems(traceData.entries);
	const turnCount = items.filter(item => item.kind === "turn").length;
	console.error(`[trace-report] ${items.length} log items (${turnCount} turns) from ${traceData.totalEvents} events`);

	const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
	const storage = new AuthStorage(store);
	await storage.reload();
	const tiny = await openModel(values.tiny, storage);
	const synth = values.synth === values.tiny ? tiny : await openModel(values.synth, storage);

	// Map: one grounded sentence per assistant turn.
	let completed = 0;
	const sentences = await mapPool(items, Number(values.concurrency), async item => {
		if (item.kind !== "turn") return undefined;
		try {
			const sentence = await ask(tiny, TINY_SYSTEM, turnPrompt(item), 300);
			return sentence.replace(/\s+/g, " ").trim();
		} finally {
			completed++;
			if (completed % 10 === 0) console.error(`[trace-report] map ${completed}/${items.length}`);
		}
	});

	const turnLog = renderTurnLog(items, sentences);

	// Reduce: story arc + failure analysis.
	const finalTurn = [...items].reverse().find(item => item.kind === "turn" && item.text.trim());
	const finalProse = finalTurn?.kind === "turn" ? finalTurn.text : "";
	const storyArc = await ask(
		synth,
		SYNTH_SYSTEM,
		synthPrompt({ run, trace, meta, status, focus: values.focus, turnLog, finalProse }),
		3000,
	);

	const report = [
		`# Trace report: ${run} / ${trace}`,
		meta,
		turnLog,
		storyArc.trim(),
		`---\n_${usageLine(tiny)}${synth === tiny ? "" : `; ${usageLine(synth)}`}_`,
	]
		.filter(Boolean)
		.join("\n\n");

	if (values.out) {
		await Bun.write(values.out, `${report}\n`);
		console.error(`[trace-report] wrote ${values.out}`);
	} else {
		console.log(report);
	}
}

await main();
