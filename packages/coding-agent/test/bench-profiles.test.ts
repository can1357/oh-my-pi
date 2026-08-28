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
import { runBenchCommand } from "@oh-my-pi/pi-coding-agent/cli/bench-cli";
import type { BenchModelRegistry } from "@oh-my-pi/pi-coding-agent/cli/bench-runtime";

const model = {
	provider: "acme",
	id: "bench-model",
	name: "bench-model",
	api: "openai-completions",
	maxTokens: 4096,
	contextWindow: 128_000,
} as unknown as Model<Api>;

const registry: BenchModelRegistry = {
	getAll: () => [model],
	getAvailable: () => [model],
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
	it("defaults to mix and rotates challenge kinds with per-kind output budgets", async () => {
		const { summary, captured } = await runProfiled({ runs: 3, par: 1 });
		expect(summary.profile).toBe("mix");
		expect(summary.models[0].results.map(run => run.challenge)).toEqual(["chat", "prefill", "generation"]);
		expect(captured.map(request => request.options?.maxTokens)).toEqual([512, 64, 2048]);
		// Per-kind aggregates exist for every kind that ran.
		expect(Object.keys(summary.models[0].byChallenge).sort()).toEqual(["chat", "generation", "prefill"]);
	});

	it("--max-tokens overrides every challenge kind", async () => {
		const { captured } = await runProfiled({ runs: 3, par: 1, maxTokens: 128 });
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
		await expect(runProfiled({ prompt: "hello" })).rejects.toThrow("--prompt");
	});
});
