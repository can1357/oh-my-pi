import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type {
	AssistantMessage,
	Context,
	Model,
	ModelSpec,
	ProviderSessionState,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

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

/** Budget-thinking Anthropic model; neutral adaptive mode should not opt it into thinking. */
function budgetModel(id: string): Model<"anthropic-messages"> {
	const base = makeAnthropicModel(id);
	return buildModel({
		...base,
		thinking: {
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		},
		compat: base.compatConfig,
	} as ModelSpec<"anthropic-messages">);
}

/** Real catalog entry — carries shipped `thinking` capability metadata. */
function bundledAnthropicModel(id: string): Model<"anthropic-messages"> {
	const model = getBundledModel<"anthropic-messages">("anthropic", id);
	// The signature is non-nullable but the lookup is a map miss away from undefined.
	if (!model) throw new Error(`missing bundled model ${id}`);
	return model;
}

const CONTEXT: Context = {
	systemPrompt: ["Stay concise."],
	messages: [{ role: "user", content: "weather in paris?", timestamp: Date.now() }],
};

function assistant(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-fable-5-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

type CapturedPayload = {
	thinking?: {
		type: string;
		display?: string;
		block_binding?: { prefix_mismatch_behavior: "drop_block" | "error" };
	};
	model?: string;
	tool_choice?: { type: string };
	output_config?: { effort?: string };
	system?: Array<{ cache_control?: { type: "ephemeral"; ttl?: "1h" | "5m" } }>;
	messages?: Array<{
		role: string;
		clear_at?: "next_user_message";
		content:
			| string
			| Array<{
					type?: string;
					cache_control?: { type: "ephemeral"; ttl?: "1h" | "5m" };
					tool?: { type: string; name: string };
			  }>;
		output_config?: { effort?: string };
	}>;
	tools?: Array<{ name: string; description?: string; defer_loading?: boolean }>;
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

function captureSimplePayload(model: Model<"anthropic-messages">, opts: SimpleStreamOptions): Promise<CapturedPayload> {
	const { promise, resolve } = Promise.withResolvers<CapturedPayload>();
	streamSimple(model, CONTEXT, {
		apiKey: "sk-ant-oat-test",
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

	it("isolates side-request controls from the main conversation", async () => {
		const model = makeAnthropicModel("claude-fable-5-1");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const readTool = { name: "read", description: "Read a file.", parameters: { type: "object", properties: {} } };
		const grepTool = { name: "grep", description: "Search files.", parameters: { type: "object", properties: {} } };
		const firstTurn: Context["messages"] = [
			{ role: "user", content: "start", timestamp: 1 },
			assistant("ready", 2),
			{ role: "user", content: "continue", timestamp: 3 },
		];
		await capturePayload(
			model,
			{ thinkingEnabled: true, providerSessionState, sessionId: "main" },
			{ systemPrompt: ["Main prompt."], messages: firstTurn, tools: [readTool] },
		);
		await capturePayload(
			model,
			{ thinkingEnabled: true, providerSessionState, sessionId: "main" },
			{ systemPrompt: ["Main prompt."], messages: firstTurn, tools: [readTool, grepTool] },
		);
		await capturePayload(
			model,
			{ thinkingEnabled: true, providerSessionState, sessionId: "main:side:1" },
			{
				systemPrompt: ["Summarize this."],
				messages: [{ role: "user", content: "summary", timestamp: 4 }],
				tools: [],
			},
		);
		const payload = await capturePayload(
			model,
			{ thinkingEnabled: true, providerSessionState, sessionId: "main" },
			{
				systemPrompt: ["Main prompt."],
				messages: [...firstTurn, assistant("done", 4), { role: "user", content: "again", timestamp: 5 }],
				tools: [readTool, grepTool],
			},
		);

		expect(payload.tools?.[1]?.defer_loading).toBe(true);
		const grepWireName = payload.tools?.[1]?.name;
		expect(grepWireName).toBeDefined();
		expect(
			payload.messages?.some(
				message =>
					Array.isArray(message.content) &&
					message.content.some(block => block.type === "tool_addition" && block.tool?.name === grepWireName),
			),
		).toBe(true);
	});

	it("keeps the first declared description when a live tool description changes", async () => {
		const model = makeAnthropicModel("claude-fable-5-1");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const messages: Context["messages"] = [
			{ role: "user", content: "start", timestamp: 1 },
			assistant("ready", 2),
			{ role: "user", content: "continue", timestamp: 3 },
		];
		await capturePayload(
			model,
			{ thinkingEnabled: true, providerSessionState },
			{
				systemPrompt: ["Stable prompt."],
				messages,
				tools: [
					{ name: "bash", description: "Original guidance.", parameters: { type: "object", properties: {} } },
				],
			},
		);
		const payload = await capturePayload(
			model,
			{ thinkingEnabled: true, providerSessionState },
			{
				systemPrompt: ["Stable prompt."],
				messages: [...messages, assistant("done", 4), { role: "user", content: "again", timestamp: 5 }],
				tools: [{ name: "bash", description: "Updated guidance.", parameters: { type: "object", properties: {} } }],
			},
		);

		expect(payload.tools?.[0]?.description).toBe("Original guidance.");
	});

	it("never caches a turn-scoped system message", async () => {
		const payload = await capturePayload(
			makeAnthropicModel("claude-fable-5-1"),
			{ thinkingEnabled: true, cacheRetention: "short" },
			{
				systemPrompt: ["Stable prompt."],
				messages: [
					{ role: "user", content: "hello", timestamp: 1 },
					{
						role: "developer",
						content: "Keep this turn brief.",
						providerPayload: { type: "anthropicMessage", clearAt: "next_user_message" },
						timestamp: 2,
					},
				],
			},
		);

		const scoped = payload.messages?.find(message => message.clear_at === "next_user_message");
		if (!scoped) throw new Error("expected a turn-scoped system message");
		if (Array.isArray(scoped.content)) {
			expect(scoped.content.some(block => block.cache_control !== undefined)).toBe(false);
		} else {
			expect(scoped.content).toBe("Keep this turn brief.");
		}
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

	it("sends an explicit effort as a control when the session started on the API default", async () => {
		// Omitted effort is the API default (`medium` on Opus 5.5), not `high`:
		// a later explicit `high` must still reach the wire.
		const model = makeAnthropicModel("claude-opus-5-5");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const first = await capturePayload(model, { thinkingEnabled: true, providerSessionState });
		const payload = await capturePayload(
			model,
			{ thinkingEnabled: true, reasoning: Effort.High, providerSessionState },
			{
				...CONTEXT,
				messages: [...CONTEXT.messages, { role: "user", content: "continue", timestamp: Date.now() }],
			},
		);

		expect(first.output_config?.effort).toBeUndefined();
		expect(payload.output_config?.effort).toBeUndefined();
		expect(payload.messages?.at(-2)?.role).toBe("system");
		expect(payload.messages?.at(-2)?.output_config?.effort).toBe("high");
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

	it("sends thinking.type:'disabled' without output_config effort for budget-based models", async () => {
		const payload = await capturePayload(makeAnthropicModel("claude-3-7-sonnet-20250219"), {
			thinkingEnabled: false,
			reasoning: Effort.High,
		});
		expect(payload.thinking?.type).toBe("disabled");
		expect(payload.output_config?.effort).toBeUndefined();
	});
});

describe("Anthropic adaptive thinking mode", () => {
	it("preserves adaptive thinking mode without fabricating an effort", async () => {
		const payload = await captureSimplePayload(adaptiveModel("claude-opus-4-8"), {
			anthropicThinkingMode: "adaptive",
		});

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config?.effort).toBeUndefined();
	});

	it("preserves neutral off mode with caller effort on off-capable Opus 5", async () => {
		const payload = await captureSimplePayload(adaptiveModel("claude-opus-5"), {
			thinkingMode: "off",
			reasoning: Effort.High,
		});

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config?.effort).toBe("high");
	});

	it("maps neutral adaptive mode without fabricating an effort", async () => {
		const payload = await captureSimplePayload(adaptiveModel("claude-opus-4-8"), {
			thinkingMode: "adaptive",
		});

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config?.effort).toBeUndefined();
	});

	it("ignores neutral adaptive mode on budget Anthropic models", async () => {
		const payload = await captureSimplePayload(budgetModel("claude-3-7-sonnet-20250219"), {
			thinkingMode: "adaptive",
		});

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config?.effort).toBeUndefined();
	});

	// These run against real bundled catalog IDs so the request-shaping tests
	// cover the metadata shipped to users, not only synthetic model specs.
	it("clamps disabled thinking to the documented ceiling on bundled Opus 5", async () => {
		const model = bundledAnthropicModel("claude-opus-5");
		// Opus 5 returns 400 for `thinking:{type:"disabled"}` above `high`.
		for (const effort of [Effort.Max, Effort.XHigh] as const) {
			const payload = await captureSimplePayload(model, { thinkingMode: "off", reasoning: effort });
			expect(payload.thinking).toEqual({ type: "disabled" });
			expect(payload.output_config?.effort).toBe("high");
		}

		// Below the ceiling the caller's effort must survive untouched.
		const medium = await captureSimplePayload(model, { thinkingMode: "off", reasoning: Effort.Medium });
		expect(medium.output_config?.effort).toBe("medium");
	});

	it("routes thinking-off requests to the off SKU while preserving effort", async () => {
		const routed = buildModel({
			...makeAnthropicModel("claude-routed"),
			thinking: {
				mode: "anthropic-adaptive",
				efforts: [Effort.Low, Effort.High],
				effortRouting: {
					off: "claude-routed",
					[Effort.High]: "claude-routed-thinking",
				},
				supportsDisabledThinking: true,
			},
		} as ModelSpec<"anthropic-messages">);

		for (const opts of [{ thinkingMode: "off" as const }, { disableReasoning: true }] as const) {
			const payload = await captureSimplePayload(routed, { ...opts, reasoning: Effort.High });

			expect(payload.model).toBe("claude-routed");
			expect(payload.thinking).toEqual({ type: "disabled" });
			expect(payload.output_config?.effort).toBe("high");
		}
	});

	it("preserves disabled thinking on forced-tool turns for bundled Opus 5 and Sonnet 5", async () => {
		const opus = await captureSimplePayload(bundledAnthropicModel("claude-opus-5"), {
			thinkingMode: "off",
			reasoning: Effort.Max,
			toolChoice: "any",
		});
		expect(opus.thinking).toEqual({ type: "disabled" });
		expect(opus.output_config?.effort).toBe("high");

		const sonnet = await captureSimplePayload(bundledAnthropicModel("claude-sonnet-5"), {
			thinkingMode: "off",
			reasoning: Effort.Max,
			toolChoice: "any",
		});
		expect(sonnet.thinking).toEqual({ type: "disabled" });
		expect(sonnet.output_config?.effort).toBe("max");
	});

	it("turns thinking off at max effort on bundled Sonnet 5, which has no ceiling", async () => {
		const payload = await captureSimplePayload(bundledAnthropicModel("claude-sonnet-5"), {
			thinkingMode: "off",
			reasoning: Effort.Max,
		});

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config?.effort).toBe("max");
	});

	it("direct provider options preserve adaptive thinking mode without effort", async () => {
		const payload = await capturePayload(adaptiveModel("claude-opus-4-8"), {
			anthropicThinkingMode: "adaptive",
		});

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config?.effort).toBeUndefined();
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
