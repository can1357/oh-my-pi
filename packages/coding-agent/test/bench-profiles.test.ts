import { describe, expect, it } from "bun:test";
import type {
	Api,
	ApiKeyResolver,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { runBenchCommand } from "@oh-my-pi/pi-coding-agent/cli/bench-cli";
import type { BenchModelRegistry } from "@oh-my-pi/pi-coding-agent/cli/bench-runtime";

const model: Model<Api> = buildModel({
	provider: "acme",
	id: "bench-model",
	name: "bench-model",
	api: "openai-completions",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 4096,
	contextWindow: 128_000,
});

// ~4K-token window, like Apple's on-device model.
const tinyModel: Model<Api> = buildModel({
	provider: "acme",
	id: "tiny-model",
	name: "tiny-model",
	api: "openai-completions",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 1024,
	contextWindow: 4096,
});

const registry: BenchModelRegistry = {
	getAll: () => [model, tinyModel],
	getAvailable: () => [model, tinyModel],
	getApiKey: async () => "sk-test",
	resolver: () => (() => Promise.resolve("sk-test")) as unknown as ApiKeyResolver,
};

interface CapturedRequest {
	context: Context;
	options: SimpleStreamOptions | undefined;
}

function streamOf(message: AssistantMessage): AssistantMessageEventStream {
	const events = [
		{ type: "text_delta", delta: "hi" },
		{ type: "done", message },
	] as unknown as AssistantMessageEvent[];
	const iterator = (async function* () {
		for (const event of events) yield event;
	})();
	return Object.assign(iterator, { result: async () => message }) as unknown as AssistantMessageEventStream;
}

function message(overrides: {
	ttft?: number;
	duration?: number;
	input?: number;
	output?: number;
	cacheWrite?: number;
}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hi" }],
		stopReason: "stop",
		usage: { input: overrides.input ?? 5, output: overrides.output ?? 20, cacheWrite: overrides.cacheWrite ?? 0 },
		duration: overrides.duration ?? 120,
		ttft: overrides.ttft ?? 30,
	} as unknown as AssistantMessage;
}

async function runProfiled(flags: Record<string, unknown>, messages?: AssistantMessage[]) {
	const captured: CapturedRequest[] = [];
	let call = 0;
	let session = 0;
	const summary = await runBenchCommand(
		{ models: ["acme/bench-model"], flags: { json: true, ...flags } },
		{
			createRuntime: async () => ({ modelRegistry: registry, close: () => {} }),
			randomSessionId: () => `sess-${session++}`,
			writeStdout: () => {},
			writeStderr: () => {},
			setExitCode: () => {},
			streamSimple: (_model, context, options) => {
				captured.push({ context, options });
				const msg = messages?.[Math.min(call, messages.length - 1)] ?? message({});
				call++;
				return streamOf(msg);
			},
			now: () => 0,
			random: () => 0,
			stdoutIsTTY: false,
		},
	);
	return { summary, captured };
}

describe("bench run metrics", () => {
	it("splits prefill and decode windows and derives per-window throughput", async () => {
		// ttft 30ms, total 120ms → 90ms decode; 20 output tokens, 5 input tokens.
		const { summary } = await runProfiled({ profile: "chat", runs: 1, par: 1 });
		const run = summary.models[0].results[0];
		expect(run.ok).toBe(true);
		if (!run.ok) return;
		expect(run.challenge).toBe("chat");
		expect(run.ttftMs).toBe(30);
		expect(run.generationMs).toBe(90);
		expect(run.inputTokens).toBe(5);
		expect(run.tokensPerSecond).toBeCloseTo(166.67, 1);
		expect(run.generationTps).toBeCloseTo(222.22, 1);
		expect(run.prefillTps).toBeCloseTo(166.67, 1);
	});

	it("counts cache-written prompt tokens toward input size", async () => {
		// Anthropic auto-caching reports most of the prompt as cacheWrite, not input.
		const { summary } = await runProfiled({ profile: "prefill", runs: 1, par: 1 }, [
			message({ input: 3, cacheWrite: 8000 }),
		]);
		const run = summary.models[0].results[0];
		expect(run.ok).toBe(true);
		if (!run.ok) return;
		expect(run.inputTokens).toBe(8003);
		expect(run.prefillTps).toBeCloseTo((8003 * 1000) / 30, 0);
	});

	it("aggregates nearest-rank percentiles over successful runs", async () => {
		const durations = [100, 200, 300, 400, 500];
		const { summary } = await runProfiled(
			{ profile: "chat", runs: 5, par: 1 },
			durations.map(duration => message({ duration })),
		);
		const stats = summary.models[0].stats;
		expect(stats).not.toBeNull();
		if (!stats) return;
		expect(stats.durationMs.min).toBe(100);
		expect(stats.durationMs.p50).toBe(300);
		expect(stats.durationMs.p95).toBe(500);
		expect(stats.durationMs.max).toBe(500);
		expect(stats.durationMs.mean).toBe(300);
	});
});

describe("bench challenge mix", () => {
	it("mix rotates challenge kinds with per-kind output budgets", async () => {
		const { summary, captured } = await runProfiled({ profile: "mix", runs: 3, par: 1 });
		expect(summary.models[0].results.map(run => run.challenge)).toEqual(["chat", "prefill", "generation"]);
		expect(captured.map(request => request.options?.maxTokens)).toEqual([512, 64, 2048]);
		// Per-kind aggregates exist for every kind that ran.
		expect(Object.keys(summary.models[0].byChallenge).sort()).toEqual(["chat", "generation", "prefill"]);
	});

	it("--max-tokens overrides every challenge kind", async () => {
		const { captured } = await runProfiled({ profile: "mix", runs: 3, par: 1, maxTokens: 128 });
		expect(captured.map(request => request.options?.maxTokens)).toEqual([128, 128, 128]);
	});

	it("prefill sends a large input with a unique cache-busting nonce per run", async () => {
		const { summary, captured } = await runProfiled({ profile: "prefill", runs: 2, par: 1 });
		expect(summary.profile).toBe("prefill");
		expect(captured).toHaveLength(2);
		const bodies = captured.map(request => {
			const first = request.context.messages[0];
			expect(request.context.messages).toHaveLength(1);
			return typeof first.content === "string" ? first.content : "";
		});
		for (const body of bodies) {
			expect(body).toMatch(/^Benchmark run sess-\d+\./);
			expect(body.length).toBeGreaterThan(32_000);
		}
		// Distinct leading bytes per run: provider prefix caches can never reuse
		// an earlier run's prefill.
		expect(bodies[0].split("\n")[0]).not.toBe(bodies[1].split("\n")[0]);
		expect(captured[0].options?.maxTokens).toBe(64);
	});

	it("prefill honors --prefill-bytes for the synthetic input size", async () => {
		const { captured } = await runProfiled({ profile: "prefill", prefillBytes: 4096, runs: 1, par: 1 });
		const body = captured[0].context.messages[0];
		const text = typeof body.content === "string" ? body.content : "";
		expect(text.length).toBeGreaterThan(4000);
		expect(text.length).toBeLessThan(8192);
	});

	it("rejects --profile combined with --cache", async () => {
		await expect(runProfiled({ profile: "generation", cache: true })).rejects.toThrow("--cache");
	});

	it("rejects --prefill-bytes when no prefill challenge can run", async () => {
		await expect(runProfiled({ profile: "chat", prefillBytes: 1024 })).rejects.toThrow("--prefill-bytes");
	});

	it("rejects --prompt when challenges are mixed", async () => {
		await expect(runProfiled({ profile: "mix", prompt: "hello" })).rejects.toThrow("--prompt");
	});

	it("caps the default prefill input to fit a small context window, unless --prefill-bytes is explicit", async () => {
		const prefillText = async (flags: Record<string, unknown>) => {
			const captured: Context[] = [];
			await runBenchCommand(
				{ models: ["acme/tiny-model"], flags: { json: true, profile: "prefill", runs: 1, par: 1, ...flags } },
				{
					createRuntime: async () => ({ modelRegistry: registry, close: () => {} }),
					writeStdout: () => {},
					writeStderr: () => {},
					setExitCode: () => {},
					streamSimple: (_model, context) => {
						captured.push(context);
						return streamOf(message({}));
					},
				},
			);
			const body = captured[0].messages[0];
			return typeof body.content === "string" ? body.content : "";
		};
		// 4096-token window → 6 KiB of filler, not the 32 KiB default.
		const capped = await prefillText({});
		expect(capped.length).toBeGreaterThan(6000);
		expect(capped.length).toBeLessThan(6500);
		expect((await prefillText({ prefillBytes: 16_384 })).length).toBeGreaterThan(16_000);
	});
});

describe("bench --detailed", () => {
	/**
	 * Every request takes 100ms on a shared fake clock. A concurrent wave opens
	 * all its streams before any finishes, so it completes in 100ms total.
	 */
	async function runDetailed(flags: Record<string, unknown>) {
		let clock = 0;
		let inFlight = 0;
		const peaks: number[] = [];
		const kinds: string[] = [];
		let session = 0;
		const summary = await runBenchCommand(
			{ models: ["acme/bench-model"], flags: { json: true, detailed: true, ...flags } },
			{
				createRuntime: async () => ({ modelRegistry: registry, close: () => {} }),
				randomSessionId: () => `sess-${session++}`,
				writeStdout: () => {},
				writeStderr: () => {},
				setExitCode: () => {},
				streamSimple: (_model, context) => {
					const first = context.messages[0];
					kinds.push(
						typeof first.content === "string" && first.content.startsWith("Benchmark run") ? "prefill" : "chat",
					);
					inFlight++;
					peaks.push(inFlight);
					const done = clock + 100;
					const msg = message({ output: 20 });
					const iterator = (async function* () {
						yield { type: "text_delta", delta: "hi" } as unknown as AssistantMessageEvent;
						clock = Math.max(clock, done);
						inFlight--;
						yield { type: "done", message: msg } as unknown as AssistantMessageEvent;
					})();
					return Object.assign(iterator, { result: async () => msg }) as unknown as AssistantMessageEventStream;
				},
				now: () => clock,
				random: () => 0,
				stdoutIsTTY: false,
			},
		);
		return { summary, peaks, kinds };
	}

	it("runs single-user, parallel, then prefill phases at their own concurrency", async () => {
		const { summary, peaks, kinds } = await runDetailed({ runs: 3, par: 2 });
		const report = summary.models[0];
		// Parallel rounds up to whole --par waves: 3 → 4.
		expect(report.results.map(run => run.phase)).toEqual([
			"single",
			"single",
			"single",
			"parallel",
			"parallel",
			"parallel",
			"parallel",
			"prefill",
			"prefill",
			"prefill",
		]);
		expect(kinds).toEqual(["chat", "chat", "chat", "chat", "chat", "chat", "chat", "prefill", "prefill", "prefill"]);
		expect(Math.max(...peaks.slice(0, 3))).toBe(1);
		expect(Math.max(...peaks.slice(3, 7))).toBe(2);
		expect(Math.max(...peaks.slice(7))).toBe(1);
		expect(summary.runs).toBe(10);
		expect(summary.detailed).toEqual({ runsPerPhase: 3, par: 2 });
		expect(summary.profile).toBeUndefined();
	});

	it("reports aggregate throughput over each phase's wall time", async () => {
		const { summary } = await runDetailed({ runs: 2, par: 2 });
		const { single, parallel, prefill } = summary.models[0].phases;
		// Single: 2 × 20 tokens back to back over 200ms.
		expect(single?.wallMs).toBe(200);
		expect(single?.aggregateTps).toBeCloseTo(200, 5);
		// Parallel: both requests overlap in one 100ms wave → twice the rate.
		expect(parallel?.concurrency).toBe(2);
		expect(parallel?.wallMs).toBe(100);
		expect(parallel?.aggregateTps).toBeCloseTo(400, 5);
		expect(prefill?.stats?.prefillTps.p50).toBeGreaterThan(0);
	});

	it("rejects combinations that would replace or collapse its phases", async () => {
		await expect(runDetailed({ profile: "chat" })).rejects.toThrow("--profile");
		await expect(runDetailed({ par: 1 })).rejects.toThrow("--par");
	});
});
