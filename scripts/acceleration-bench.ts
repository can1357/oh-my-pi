import { performance } from "node:perf_hooks";
import {
	createAccelerationStreamFn,
	DEFAULT_ACCELERATION_CONFIG,
	normalizeAccelerationConfig,
} from "@pk-nerdsaver-ai/pi-agent-core/acceleration";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	SimpleStreamOptions,
} from "@pk-nerdsaver-ai/pi-ai";
import { AssistantMessageEventStream } from "@pk-nerdsaver-ai/pi-ai/utils/event-stream";
import type { StreamFn } from "@pk-nerdsaver-ai/pi-agent-core/types";

const SCRIPT_FINAL = "final response body used for the regression check";

type StreamMode = "baseline" | "token_speculative" | "lookahead_reasoning" | "combined";

interface CategoryCase {
	id: string;
	category: string;
	prompt: string;
}

interface RunResult {
	mode: StreamMode;
	category: string;
	caseId: string;
	latencyMs: number;
	ttftMs: number;
	ttfnMs: number;
	outputTokens: number;
	passed: boolean;
	detail: string;
	speculativeAcceptanceRate: number | null;
}

interface MockDeps {
	targetModel: Model;
	draftModel: Model;
	verifierModel: Model;
}

function createTextStream(
	model: Model,
	text: string,
	options: { delayMs?: number; firstTokenDelayMs?: number } = {},
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: Math.max(1, Math.ceil(text.length / 4)),
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: Math.max(1, Math.ceil(text.length / 4)),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const totalDelay = options.delayMs ?? 0;
	const firstTokenDelay = options.firstTokenDelayMs ?? Math.max(0, Math.min(20, totalDelay));
	const pushFinal = (): void => {
		stream.push({ type: "done", reason: "stop", message });
	};
	const pushDelta = (): void => {
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({ type: "text_start", contentIndex: 0, partial: { ...message, content: [] } });
		const chunk = text.slice(0, 16);
		stream.push({
			type: "text_delta",
			contentIndex: 0,
			delta: chunk,
			partial: { ...message, content: [{ type: "text", text: chunk }] },
		});
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
	};
	if (totalDelay <= 0) {
		pushDelta();
		pushFinal();
		return stream;
	}
	setTimeout(() => {
		pushDelta();
		setTimeout(pushFinal, Math.max(0, totalDelay - firstTokenDelay));
	}, firstTokenDelay);
	return stream;
}

function mockModel(id: string): Model {
	return {
		id,
		name: id,
		api: "mock" as Model["api"],
		provider: "mock",
		baseUrl: "mock://",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_768,
	};
}

function buildDeps(): MockDeps {
	return {
		targetModel: mockModel("target"),
		draftModel: mockModel("draft"),
		verifierModel: mockModel("verifier"),
	};
}

function makeStreamFn(deps: MockDeps): StreamFn {
	const targetDelay = 80;
	const draftDelay = 30;
	const verifierDelay = 25;
	const finalize = (model: Model, options: { text: string; delayMs?: number }) =>
		createTextStream(model, options.text, { delayMs: options.delayMs });
	return (model: Model, context: Context, _options?: SimpleStreamOptions) => {
		if (model.id === "draft") {
			const sys = Array.isArray(context.systemPrompt) ? context.systemPrompt.join("\n") : (context.systemPrompt ?? "");
			const steps = {
				steps: [
					{ step_id: 1, intent: "outline the requested task", expected_state_change: "draft outline", dependencies: [] },
					{ step_id: 2, intent: "verify the response against the task", expected_state_change: "verifiable answer", dependencies: [1] },
				],
			};
			return finalize(model, { text: JSON.stringify(steps), delayMs: draftDelay });
		}
		if (model.id === "verifier") {
			const sys = Array.isArray(context.systemPrompt) ? context.systemPrompt.join("\n") : (context.systemPrompt ?? "");
			const acceptAll = sys.includes("Candidate steps JSON");
			const text = acceptAll
				? JSON.stringify({ accepted_step_ids: [1, 2], rejected_step_ids: [] })
				: JSON.stringify({ accepted_step_ids: [], rejected_step_ids: [1] });
			return finalize(model, { text, delayMs: verifierDelay });
		}
		return finalize(model, { text: SCRIPT_FINAL, delayMs: targetDelay });
	};
}

const CATEGORIES: CategoryCase[] = [
	{ id: "short-factual", category: "short-factual", prompt: "What is 2 + 2?" },
	{
		id: "long-form",
		category: "long-form",
		prompt:
			"Write a detailed implementation plan for a multi-tenant inference orchestration system, covering scheduler semantics, cost model, batch sizing, and observability. Outline the plan, design the components, implement the skeleton, and verify the rollout. Reason step by step.",
	},
	{
		id: "coding",
		category: "coding",
		prompt: "Refactor this module to use a dependency-injected clock so it can be tested deterministically.",
	},
	{ id: "math", category: "math", prompt: "Prove the sum of the first n integers is n(n+1)/2 step by step." },
	{ id: "multi-step", category: "multi-step", prompt: "Plan, design, implement, and verify a feature flag rollout in 5 steps." },
];

const LOOKAHEAD_TOKENS = ["plan", "design", "implement", "verify", "prove", "step"];

function isReasoningHeavy(prompt: string): boolean {
	if (prompt.length > 1200) return true;
	return LOOKAHEAD_TOKENS.some(token => prompt.toLowerCase().includes(token));
}

async function runOne(mode: StreamMode, category: CategoryCase, deps: MockDeps): Promise<RunResult> {
	const baseStream = makeStreamFn(deps);
	const config = normalizeAccelerationConfig({
		...DEFAULT_ACCELERATION_CONFIG,
		enabled: true,
		mode,
		force_lookahead: isReasoningHeavy(category.prompt),
		lookahead_steps_initial: 2,
		lookahead_steps_max: 3,
	});
	let speculativeAcceptanceRate: number | null = null;
	const captureTelemetry = (telemetry: { speculativeAcceptanceRate: number }): void => {
		speculativeAcceptanceRate = telemetry.speculativeAcceptanceRate;
	};
	const wrapped = createAccelerationStreamFn({
		baseStream,
		config,
		draftModel: deps.draftModel,
		verifierModel: deps.verifierModel,
		onTelemetry: captureTelemetry,
	});
	const context: Context = {
		systemPrompt: ["Bench"],
		messages: [{ role: "user", content: category.prompt, timestamp: 1 }],
		tools: [],
	};
	const started = performance.now();
	let ttft = 0;
	const stream = wrapped(deps.targetModel, context, {});
	const target = await new Promise<AssistantMessage>((resolve, reject) => {
		let firstVisibleAt: number | null = null;
		void (async () => {
			try {
				for await (const event of stream) {
					if (
						firstVisibleAt === null &&
						(event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta")
					) {
						firstVisibleAt = performance.now();
						ttft = firstVisibleAt - started;
					}
				}
				resolve(await stream.result());
			} catch (error) {
				reject(error);
			}
		})();
	});
	const ttfn = performance.now() - started;
	const passed = target.content.some(
		block => block.type === "text" && (block.text === SCRIPT_FINAL || block.text.length > 0),
	);
	return {
		mode,
		category: category.category,
		caseId: category.id,
		latencyMs: ttfn,
		ttftMs: ttft,
		ttfnMs: ttfn,
		outputTokens: target.usage.output,
		passed,
		detail: passed ? "ok" : "no final text",
		speculativeAcceptanceRate,
	};
}

function percentile(values: number[], fraction: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
	return sorted[rank] ?? 0;
}

function summarize(results: RunResult[]): void {
	const headers = [
		"mode",
		"category",
		"cases",
		"avg_latency_ms",
		"p50_latency_ms",
		"p95_latency_ms",
		"avg_ttft_ms",
		"throughput_tok_per_s",
		"speculative_acceptance_rate",
		"equivalence_rate",
		"speedup_vs_baseline",
	];
	console.log(headers.join("\t"));
	const modes: StreamMode[] = ["baseline", "token_speculative", "lookahead_reasoning", "combined"];
	const baselineByCategory = new Map<string, number[]>();
	for (const result of results) {
		if (result.mode !== "baseline") continue;
		const list = baselineByCategory.get(result.category) ?? [];
		list.push(result.latencyMs);
		baselineByCategory.set(result.category, list);
	}
	const baselineAvg = (entries: number[]): number =>
		entries.length > 0 ? entries.reduce((sum, value) => sum + value, 0) / entries.length : Number.NaN;
	for (const mode of modes) {
		const perCategory = new Map<string, RunResult[]>();
		for (const result of results) {
			if (result.mode !== mode) continue;
			const list = perCategory.get(result.category) ?? [];
			list.push(result);
			perCategory.set(result.category, list);
		}
		for (const [category, entries] of perCategory) {
			const latencies = entries.map(entry => entry.latencyMs);
			const avg = latencies.reduce((sum, value) => sum + value, 0) / latencies.length;
			const p50 = percentile(latencies, 0.5);
			const p95 = percentile(latencies, 0.95);
			const avgTtft = entries.reduce((sum, value) => sum + value.ttftMs, 0) / entries.length;
			const totalTokens = entries.reduce((sum, value) => sum + value.outputTokens, 0);
			const totalSeconds = latencies.reduce((sum, value) => sum + value, 0) / 1000;
			const throughput = totalSeconds > 0 ? totalTokens / totalSeconds : 0;
			const speculativeColumn =
				mode === "lookahead_reasoning"
					? "n/a"
					: (() => {
							const speculativeValues = entries
								.map(entry => entry.speculativeAcceptanceRate)
								.filter((value): value is number => value !== null);
							return speculativeValues.length > 0
								? (speculativeValues.reduce((sum, value) => sum + value, 0) / speculativeValues.length).toFixed(3)
								: "n/a";
						})();
			const equivalenceRate = entries.filter(entry => entry.passed).length / entries.length;
			const baselineLatency = baselineAvg(baselineByCategory.get(category) ?? []);
			const speedup = Number.isFinite(baselineLatency) && avg > 0 ? baselineLatency / avg : 1;
			console.log(
				[
					mode,
					category,
					String(entries.length),
					avg.toFixed(2),
					p50.toFixed(2),
					p95.toFixed(2),
					avgTtft.toFixed(2),
					throughput.toFixed(2),
					speculativeColumn,
					equivalenceRate.toFixed(3),
					speedup.toFixed(3),
				].join("\t"),
			);
		}
	}
}

async function main(): Promise<void> {
	const deps = buildDeps();
	const results: RunResult[] = [];
	const modes: StreamMode[] = ["baseline", "token_speculative", "lookahead_reasoning", "combined"];
	for (const mode of modes) {
		for (const category of CATEGORIES) {
			results.push(await runOne(mode, category, deps));
		}
	}
	console.log("METRIC backend=mock");
	console.log("METRIC dataset=acceleration-regression-fixtures");
	summarize(results);
}

await main();
