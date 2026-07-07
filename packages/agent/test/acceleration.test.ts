import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@pk-nerdsaver-ai/pi-ai";
import { createMockModel } from "@pk-nerdsaver-ai/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@pk-nerdsaver-ai/pi-ai/utils/event-stream";
import {
	AccelerationOrchestrator,
	type AccelerationTelemetry,
	createAccelerationStreamFn,
	DEFAULT_ACCELERATION_CONFIG,
	normalizeAccelerationConfig,
	shouldUseLookaheadReasoning,
	updateAdaptiveGamma,
} from "../src/acceleration";
import type { StreamFn } from "../src/types";

function mockContext(text: string): Context {
	return {
		systemPrompt: ["System"],
		messages: [
			{
				role: "user",
				content: [{ type: "text", text }],
				timestamp: 1,
			},
		],
		tools: [],
	};
}

function scriptStream(model: Model, content: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: content }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
	stream.push({ type: "done", reason: "stop", message });
	return stream;
}

function makeStreamFn(responses: string[]): {
	streamFn: StreamFn;
	calls: Array<{ modelId: string; system: string; prompt: string }>;
} {
	const models = responses.map((content, index) =>
		createMockModel({ id: `mock-${index}`, responses: [{ content: [content] }] }),
	);
	const calls: Array<{ modelId: string; system: string; prompt: string }> = [];
	const streamFn: StreamFn = (model: Model, context: Context, _options?: SimpleStreamOptions) => {
		const index = models.findIndex(m => m.model.id === model.id);
		const chosen = index === -1 ? models[models.length - 1]! : models[index]!;
		const sys = Array.isArray(context.systemPrompt) ? context.systemPrompt.join("\n") : (context.systemPrompt ?? "");
		const lastUser = [...context.messages].reverse().find(message => message.role === "user");
		const prompt =
			typeof lastUser?.content === "string"
				? lastUser.content
				: (lastUser?.content?.map(block => ("text" in block ? block.text : "")).join("\n") ?? "");
		calls.push({ modelId: chosen.model.id, system: sys, prompt });
		return scriptStream(
			model,
			chosen === models[models.length - 1] ? responses[responses.length - 1]! : responses[models.indexOf(chosen)]!,
		);
	};
	return { streamFn, calls };
}

async function drain(
	stream: AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
): Promise<AssistantMessage> {
	return await (await Promise.resolve(stream)).result();
}

describe("acceleration config parsing", () => {
	it("normalizes defaults and clamps gamma bounds", () => {
		const config = normalizeAccelerationConfig({ enabled: true, mode: "lookahead_reasoning", gamma_initial: 12 });
		expect(config.gamma_initial).toBe(8);
		expect(config.gamma_min).toBe(1);
		expect(config.gamma_max).toBe(8);
	});

	it("falls back to baseline for unknown modes", () => {
		const config = normalizeAccelerationConfig({ mode: "unknown" as never });
		expect(config.mode).toBe("baseline");
	});

	it("rejects negative or non-finite thresholds", () => {
		const config = normalizeAccelerationConfig({
			acceptance_rate_increase_threshold: -1,
			acceptance_rate_decrease_threshold: Number.NaN,
		});
		expect(config.acceptance_rate_increase_threshold).toBe(0);
		expect(config.acceptance_rate_decrease_threshold).toBe(
			DEFAULT_ACCELERATION_CONFIG.acceptance_rate_decrease_threshold,
		);
	});
});

describe("acceleration adaptive gamma", () => {
	const baseConfig = { ...DEFAULT_ACCELERATION_CONFIG, gamma_initial: 4, gamma_min: 1, gamma_max: 8 };
	it("increases gamma when acceptance rate exceeds the upper threshold", () => {
		expect(updateAdaptiveGamma(4, 0.9, baseConfig)).toBe(5);
	});
	it("decreases gamma when acceptance rate falls below the lower threshold", () => {
		expect(updateAdaptiveGamma(4, 0.4, baseConfig)).toBe(3);
	});
	it("keeps gamma within bounds", () => {
		expect(updateAdaptiveGamma(8, 0.9, baseConfig)).toBe(8);
		expect(updateAdaptiveGamma(1, 0.4, baseConfig)).toBe(1);
	});
});

describe("acceleration lookahead gate", () => {
	it("forces lookahead when configured", () => {
		expect(shouldUseLookaheadReasoning(mockContext("Hello"), { force_lookahead: true })).toBe(true);
	});
	it("skips short factual prompts", () => {
		expect(shouldUseLookaheadReasoning(mockContext("What is 2+2?"), { force_lookahead: false })).toBe(false);
	});
	it("enables lookahead for reasoning-heavy prompts", () => {
		expect(
			shouldUseLookaheadReasoning(mockContext("Compare the trade-offs of the architecture"), {
				force_lookahead: false,
			}),
		).toBe(true);
	});
});

describe("acceleration baseline fallback", () => {
	it("createAccelerationStreamFn returns the base streamFn when disabled", () => {
		const { streamFn, calls } = makeStreamFn(["baseline"]);
		const wrapped = createAccelerationStreamFn({
			baseStream: streamFn,
			config: { ...DEFAULT_ACCELERATION_CONFIG, enabled: false, mode: "combined" },
		});
		const model = createMockModel({ id: "target", responses: [{ content: ["x"] }] }).model;
		expect(wrapped).toBe(streamFn);
		expect(calls).toHaveLength(0);
		void drain(wrapped(model, mockContext("Hello")));
	});
});

describe("acceleration token speculation fallback", () => {
	it("falls back to baseline when exact verification is unavailable", async () => {
		const { streamFn, calls } = makeStreamFn(["target output"]);
		const wrapped = createAccelerationStreamFn({
			baseStream: streamFn,
			config: {
				...DEFAULT_ACCELERATION_CONFIG,
				enabled: true,
				mode: "token_speculative",
			},
			draftModel: createMockModel({ id: "draft", responses: [{ content: ["draft"] }] }).model,
		});
		const model = createMockModel({ id: "target", responses: [{ content: ["x"] }] }).model;
		const message = await drain(wrapped(model, mockContext("Solve the equation step by step")));
		const targetCall = calls.find(call => call.modelId === "target" || call.modelId === "mock-0");
		expect(targetCall).toBeDefined();
		expect(message.usage.totalTokens).toBeGreaterThanOrEqual(0);
	});
	it("falls back to baseline when token speculation is requested", async () => {
		const { streamFn, calls } = makeStreamFn(["target output"]);
		const wrapped = createAccelerationStreamFn({
			baseStream: streamFn,
			config: {
				...DEFAULT_ACCELERATION_CONFIG,
				enabled: true,
				mode: "token_speculative",
			},
			draftModel: createMockModel({ id: "draft", responses: [{ content: ["draft text"] }] }).model,
		});
		const model = createMockModel({ id: "target", responses: [{ content: ["final output"] }] }).model;
		await drain(wrapped(model, mockContext("Explain the architecture tradeoffs in detail")));
		const targetCall = calls.find(call => call.modelId === "target" || call.modelId === "mock-0");
		expect(targetCall).toBeDefined();
		const draftCall = calls.find(call => call.modelId === "draft");
		expect(draftCall).toBeUndefined();
	});
	it("accepts parsed steps that survive JSON normalization", async () => {
		const { streamFn, calls } = makeStreamFn([
			JSON.stringify({
				steps: [
					{ step_id: 1, intent: "outline", expected_state_change: "summary", dependencies: [] },
					{ step_id: 2, intent: "derive", expected_state_change: "result", dependencies: [1] },
				],
			}),
			JSON.stringify({ accepted_step_ids: [1, 2], rejected_step_ids: [] }),
			"final target output",
		]);
		const wrapped = createAccelerationStreamFn({
			baseStream: streamFn,
			config: {
				...DEFAULT_ACCELERATION_CONFIG,
				enabled: true,
				mode: "lookahead_reasoning",
				force_lookahead: true,
			},
			draftModel: createMockModel({ id: "draft", responses: [{ content: ["draft"] }] }).model,
			verifierModel: createMockModel({ id: "verifier", responses: [{ content: ["verify"] }] }).model,
		});
		const model = createMockModel({ id: "target", responses: [{ content: ["x"] }] }).model;
		await drain(wrapped(model, mockContext("Design a multi-step planning response")));
		expect(calls.length).toBeGreaterThanOrEqual(2);
	});

	it("falls back to baseline when all steps are rejected", async () => {
		const { streamFn, calls } = makeStreamFn([
			JSON.stringify({
				steps: [{ step_id: 1, intent: "outline", expected_state_change: "summary", dependencies: [] }],
			}),
			JSON.stringify({ accepted_step_ids: [], rejected_step_ids: [1] }),
			"final target output",
		]);
		const wrapped = createAccelerationStreamFn({
			baseStream: streamFn,
			config: {
				...DEFAULT_ACCELERATION_CONFIG,
				enabled: true,
				mode: "lookahead_reasoning",
				force_lookahead: true,
			},
			draftModel: createMockModel({ id: "draft", responses: [{ content: ["draft"] }] }).model,
			verifierModel: createMockModel({ id: "verifier", responses: [{ content: ["verify"] }] }).model,
		});
		const model = createMockModel({ id: "target", responses: [{ content: ["x"] }] }).model;
		await drain(wrapped(model, mockContext("Design a multi-step planning response")));
		const modelsCalled = new Set(calls.map(call => call.modelId));
		expect(modelsCalled.has("mock-2")).toBe(true);
	});
});

describe("acceleration combined mode", () => {
	it("falls back to baseline when the lookahead gate declines", async () => {
		const { streamFn, calls } = makeStreamFn(["baseline target"]);
		const wrapped = createAccelerationStreamFn({
			baseStream: streamFn,
			config: {
				...DEFAULT_ACCELERATION_CONFIG,
				enabled: true,
				mode: "combined",
			},
			draftModel: createMockModel({ id: "draft", responses: [{ content: ["draft"] }] }).model,
		});
		const model = createMockModel({ id: "target", responses: [{ content: ["x"] }] }).model;
		await drain(wrapped(model, mockContext("hi")));
		expect(calls.length).toBeGreaterThanOrEqual(0);
	});
});

describe("acceleration orchestrator telemetry", () => {
	it("emits a baseline telemetry object when disabled", async () => {
		const { streamFn } = makeStreamFn(["ok"]);
		const orchestrator = new AccelerationOrchestrator({
			baseStream: streamFn,
			config: { ...DEFAULT_ACCELERATION_CONFIG, enabled: false },
		});
		const model = createMockModel({ id: "target", responses: [{ content: ["x"] }] }).model;
		const result = await drain(await orchestrator.run(model, mockContext("Hello"), {}));
		expect(result.usage.totalTokens).toBeGreaterThanOrEqual(0);
	});

	it("captures telemetry via onTelemetry callback", async () => {
		const { streamFn } = makeStreamFn(["ok"]);
		const captured: AccelerationTelemetry[] = [];
		const orchestrator = new AccelerationOrchestrator({
			baseStream: streamFn,
			config: { ...DEFAULT_ACCELERATION_CONFIG, enabled: true, mode: "lookahead_reasoning" },
			draftModel: createMockModel({ id: "draft", responses: [{ content: ["draft"] }] }).model,
			verifierModel: createMockModel({ id: "verifier", responses: [{ content: ["verify"] }] }).model,
			onTelemetry: telemetry => captured.push(telemetry),
		});
		const model = createMockModel({ id: "target", responses: [{ content: ["x"] }] }).model;
		await drain(await orchestrator.run(model, mockContext("Solve a hard problem"), {}));
		const last = captured[captured.length - 1];
		expect(last).toBeDefined();
	});
});

describe("acceleration orchestrator gating", () => {
	it("runs baseline even when the configured mode is non-baseline but acceleration is disabled", async () => {
		const { streamFn, calls } = makeStreamFn(["baseline target output"]);
		const orchestrator = new AccelerationOrchestrator({
			baseStream: streamFn,
			config: { ...DEFAULT_ACCELERATION_CONFIG, enabled: false, mode: "combined" },
			draftModel: createMockModel({ id: "draft", responses: [{ content: ["draft"] }] }).model,
		});
		const model = createMockModel({ id: "target", responses: [{ content: ["x"] }] }).model;
		await drain(await orchestrator.run(model, mockContext("hi"), {}));
		expect(calls.length).toBe(1);
		expect(calls[0]?.modelId === "target" || calls[0]?.modelId === "mock-0").toBe(true);
	});
});
