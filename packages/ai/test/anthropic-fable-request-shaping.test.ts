import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, Model, ModelSpec, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

function makeAnthropicModel(id: string): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
}

function makeMiniMaxAnthropicModel(id: string): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "minimax",
		baseUrl: "https://api.minimax.io/anthropic",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
}

/** Adaptive-thinking model (Opus 4.6+, Sonnet 4.6+, Fable/Mythos 5). */
function adaptiveModel(id: string): Model<"anthropic-messages"> {
	const base = makeAnthropicModel(id);
	return buildModel({
		...base,
		thinking: {
			mode: "anthropic-adaptive",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		},
		compat: base.compatConfig,
	} as ModelSpec<"anthropic-messages">);
}

const CONTEXT: Context = {
	systemPrompt: ["Stay concise."],
	messages: [{ role: "user", content: "weather in paris?", timestamp: Date.now() }],
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

type CapturedPayload = {
	thinking?: {
		type: string;
		block_binding?: { prefix_mismatch_behavior: "drop_block" | "error" };
	};
	tool_choice?: { type: string };
	output_config?: { effort?: string };
	system?: Array<{ cache_control?: { type: "ephemeral"; ttl?: "1h" | "5m" } }>;
	messages?: Array<{
		role: string;
		content:
			| string
			| Array<{
					type?: string;
					cache_control?: { type: "ephemeral"; ttl?: "1h" | "5m" };
					tool?: { type: string; name: string };
			  }>;
		output_config?: { effort?: string };
	}>;
	tools?: Array<{ name: string; defer_loading?: boolean }>;
	anthropic_beta?: string[];
};

function capturePayload(
	model: Model<"anthropic-messages">,
	opts: Parameters<typeof streamAnthropic>[2],
	context: Context = CONTEXT,
): Promise<CapturedPayload> {
	const { promise, resolve } = Promise.withResolvers<CapturedPayload>();
	streamAnthropic(model, context, {
		apiKey: "sk-ant-oat-test",
		isOAuth: true,
		signal: abortedSignal(),
		onPayload: payload => resolve(payload as CapturedPayload),
		...opts,
	});
	return promise;
}

describe("Anthropic preserved-thinking request shaping", () => {
	it("opts Fable 5.1 into dropping prefix-mismatched thinking", async () => {
		const payload = await capturePayload(makeAnthropicModel("claude-fable-5-1"), {
			thinkingEnabled: true,
			reasoning: Effort.High,
		});

		expect(payload.thinking?.block_binding).toEqual({ prefix_mismatch_behavior: "drop_block" });
	});

	it("allows callers to make prefix mismatches fail loudly", async () => {
		const payload = await capturePayload(makeAnthropicModel("claude-fable-5-1"), {
			thinkingEnabled: true,
			reasoning: Effort.High,
			anthropicPrefixMismatchBehavior: "error",
		});

		expect(payload.thinking?.block_binding).toEqual({ prefix_mismatch_behavior: "error" });
	});

	it("keeps OAuth cache breakpoint TTLs monotonic", async () => {
		const payload = await capturePayload(makeAnthropicModel("claude-fable-5-1"), {
			thinkingEnabled: true,
			reasoning: Effort.High,
			cacheRetention: "long",
		});

		expect(payload.system?.[1]?.cache_control?.ttl).toBe("1h");
		const messageContent = payload.messages?.[0]?.content;
		if (!Array.isArray(messageContent)) throw new Error("expected block message content");
		expect(messageContent.at(-1)?.cache_control?.ttl).toBe("1h");
	});

	it("keeps declared tools stable and appends a removal control", async () => {
		const model = makeAnthropicModel("claude-fable-5-1");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const firstContext: Context = {
			...CONTEXT,
			tools: [
				{
					name: "read",
					description: "Read a file.",
					parameters: { type: "object", properties: {} },
				},
			],
		};
		await capturePayload(
			model,
			{ thinkingEnabled: true, reasoning: Effort.High, providerSessionState },
			firstContext,
		);
		const payload = await capturePayload(
			model,
			{ thinkingEnabled: true, reasoning: Effort.High, providerSessionState },
			{
				...CONTEXT,
				messages: [...CONTEXT.messages, { role: "user", content: "continue", timestamp: Date.now() }],
				tools: [],
			},
		);

		const wireToolName = payload.tools?.[0]?.name;
		if (!wireToolName) throw new Error("expected stable declared tool");
		const lastContent = payload.messages?.at(-1)?.content;
		if (!Array.isArray(lastContent)) throw new Error("expected system control blocks");
		expect(lastContent).toContainEqual({
			type: "tool_removal",
			tool: { type: "tool_reference", name: wireToolName },
		});
	});

	it("re-baselines tools when the history under a control is rewritten", async () => {
		const model = makeAnthropicModel("claude-fable-5-1");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const readTool = { name: "read", description: "Read a file.", parameters: { type: "object", properties: {} } };
		await capturePayload(
			model,
			{ thinkingEnabled: true, reasoning: Effort.High, providerSessionState },
			{ ...CONTEXT, tools: [readTool] },
		);
		await capturePayload(
			model,
			{ thinkingEnabled: true, reasoning: Effort.High, providerSessionState },
			{
				...CONTEXT,
				messages: [...CONTEXT.messages, { role: "user", content: "continue", timestamp: Date.now() }],
				tools: [],
			},
		);
		// Same length, different first turn: a compaction-style rewrite under the recorded control.
		const payload = await capturePayload(
			model,
			{ thinkingEnabled: true, reasoning: Effort.High, providerSessionState },
			{
				...CONTEXT,
				messages: [
					{ role: "user", content: "summary of the session so far", timestamp: Date.now() },
					{ role: "user", content: "continue", timestamp: Date.now() },
				],
				tools: [],
			},
		);

		expect(payload.tools ?? []).toHaveLength(0);
		expect(payload.messages?.some(message => message.role === "system")).toBe(false);
	});

	it("changes effort through a system message placed before the latest user turn", async () => {
		const model = makeAnthropicModel("claude-fable-5-1");
		const providerSessionState = new Map<string, ProviderSessionState>();
		await capturePayload(model, {
			thinkingEnabled: true,
			reasoning: Effort.High,
			providerSessionState,
		});
		const payload = await capturePayload(
			model,
			{ thinkingEnabled: true, reasoning: Effort.Low, providerSessionState },
			{
				...CONTEXT,
				messages: [...CONTEXT.messages, { role: "user", content: "continue", timestamp: Date.now() }],
			},
		);

		expect(payload.output_config?.effort).toBe("high");
		// Per-message effort applies from the next user turn, so the control must
		// precede the turn being answered rather than trail it.
		expect(payload.messages?.at(-2)?.role).toBe("system");
		expect(payload.messages?.at(-2)?.output_config?.effort).toBe("low");
		expect(payload.messages?.at(-1)?.role).toBe("user");
	});
});

describe("Anthropic Fable/Mythos forced tool_choice", () => {
	it("downgrades a forced tool to auto for Fable (which rejects forced tool use)", async () => {
		const payload = await capturePayload(adaptiveModel("claude-fable-5"), {
			toolChoice: { type: "tool", name: "get_weather" },
		});
		expect(payload.tool_choice?.type).toBe("auto");
	});

	it("downgrades tool_choice:'any' to auto for Mythos", async () => {
		const payload = await capturePayload(adaptiveModel("claude-mythos-5"), {
			toolChoice: "any",
		});
		expect(payload.tool_choice?.type).toBe("auto");
	});

	it("preserves a forced tool_choice for non-Fable models (Opus 4.8 supports it)", async () => {
		const payload = await capturePayload(adaptiveModel("claude-opus-4-8"), {
			toolChoice: { type: "tool", name: "get_weather" },
		});
		expect(payload.tool_choice?.type).toBe("tool");
	});
});

describe("Anthropic adaptive-only thinking disable", () => {
	it("never sends thinking.type:'disabled' to an adaptive-only model, pins lowest effort", async () => {
		const payload = await capturePayload(adaptiveModel("claude-fable-5"), {
			thinkingEnabled: false,
		});
		expect(payload.thinking).toBeUndefined();
		expect(payload.output_config?.effort).toBe("low");
	});

	it("still sends thinking.type:'disabled' for budget-based (non-adaptive) models", async () => {
		const payload = await capturePayload(makeAnthropicModel("claude-3-7-sonnet-20250219"), {
			thinkingEnabled: false,
		});
		expect(payload.thinking?.type).toBe("disabled");
	});
});

describe("MiniMax Anthropic adaptive thinking", () => {
	it("serializes MiniMax adaptive reasoning without Anthropic output_config effort", async () => {
		const payload = await capturePayload(makeMiniMaxAnthropicModel("MiniMax-M3"), {
			reasoning: Effort.High,
			thinkingEnabled: true,
		});

		expect(payload.thinking).toEqual({ type: "adaptive" });
		expect(payload.output_config?.effort).toBeUndefined();
	});

	it("maps direct MiniMax effort options to the adaptive tag only", async () => {
		const payload = await capturePayload(makeMiniMaxAnthropicModel("MiniMax-M3"), {
			effort: "low",
			thinkingEnabled: true,
		});

		expect(payload.thinking).toEqual({ type: "adaptive" });
		expect(payload.output_config?.effort).toBeUndefined();
	});

	it("serializes MiniMax M3 thinking-off requests without the Claude effort pin", async () => {
		const payload = await capturePayload(makeMiniMaxAnthropicModel("MiniMax-M3"), {
			thinkingEnabled: false,
		});

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config?.effort).toBeUndefined();
	});
	it("maps every MiniMax M2 reasoning tier to the documented adaptive tag", async () => {
		const payload = await capturePayload(makeMiniMaxAnthropicModel("MiniMax-M2.7"), {
			reasoning: Effort.Low,
			thinkingEnabled: true,
		});

		expect(payload.thinking).toEqual({ type: "adaptive" });
		expect(payload.output_config?.effort).toBeUndefined();
	});
});
