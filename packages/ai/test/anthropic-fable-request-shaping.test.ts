import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AssistantMessage, Context, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
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
		block_binding?: { prefix_mismatch_behavior: "drop_block" | "error" };
	};
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

type CapturedTurn = { payload: CapturedPayload; message: AssistantMessage };

/** Builds one request through the real param path; `message` is the terminal message carrying its controls. */
async function captureTurn(
	model: Model<"anthropic-messages">,
	opts: Parameters<typeof streamAnthropic>[2],
	context: Context = CONTEXT,
): Promise<CapturedTurn> {
	let payload: CapturedPayload | undefined;
	const message = await streamAnthropic(model, context, {
		apiKey: "sk-ant-oat-test",
		isOAuth: true,
		signal: abortedSignal(),
		onPayload: captured => {
			payload = captured as CapturedPayload;
		},
		...opts,
	}).result();
	if (!payload) throw new Error("expected a built payload");
	return { payload, message };
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	opts: Parameters<typeof streamAnthropic>[2],
	context: Context = CONTEXT,
): Promise<CapturedPayload> {
	return (await captureTurn(model, opts, context)).payload;
}

/** The reply to `turn`, recording the controls its request declared. */
function answered(text: string, turn: CapturedTurn): AssistantMessage {
	return { ...assistant(text, Date.now()), requestControls: turn.message.requestControls };
}

const READ_TOOL = { name: "read", description: "Read a file.", parameters: { type: "object", properties: {} } };

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
		const first = await captureTurn(
			model,
			{ thinkingEnabled: true, reasoning: Effort.High },
			{ ...CONTEXT, tools: [READ_TOOL] },
		);
		const payload = await capturePayload(
			model,
			{ thinkingEnabled: true, reasoning: Effort.High },
			{
				...CONTEXT,
				messages: [
					...CONTEXT.messages,
					answered("sunny", first),
					{ role: "user", content: "continue", timestamp: Date.now() },
				],
				tools: [],
				inactiveTools: [READ_TOOL],
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
		const first = await captureTurn(model, { thinkingEnabled: true, reasoning: Effort.High });
		const payload = await capturePayload(
			model,
			{ thinkingEnabled: true, reasoning: Effort.Low },
			{
				...CONTEXT,
				messages: [
					...CONTEXT.messages,
					answered("sunny", first),
					{ role: "user", content: "continue", timestamp: Date.now() },
				],
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
		const first = await captureTurn(model, { thinkingEnabled: true });
		const payload = await capturePayload(
			model,
			{ thinkingEnabled: true, reasoning: Effort.High },
			{
				...CONTEXT,
				messages: [
					...CONTEXT.messages,
					answered("sunny", first),
					{ role: "user", content: "continue", timestamp: Date.now() },
				],
			},
		);

		expect(first.payload.output_config?.effort).toBeUndefined();
		expect(payload.output_config?.effort).toBeUndefined();
		expect(payload.messages?.at(-2)?.role).toBe("system");
		expect(payload.messages?.at(-2)?.output_config?.effort).toBe("high");
		expect(payload.messages?.at(-1)?.role).toBe("user");
	});
});

describe("Anthropic forced tool_choice", () => {
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

	it("downgrades a forced tool to auto for Opus 5.5 (rejects forced tool use)", async () => {
		const payload = await capturePayload(adaptiveModel("claude-opus-5-5"), {
			toolChoice: { type: "tool", name: "get_weather" },
		});
		expect(payload.tool_choice?.type).toBe("auto");
	});

	it("preserves a forced tool_choice below the Opus 5.5 floor (Opus 5, Opus 4.8)", async () => {
		for (const id of ["claude-opus-5", "claude-opus-4-8"]) {
			const payload = await capturePayload(adaptiveModel(id), {
				toolChoice: { type: "tool", name: "get_weather" },
			});
			expect(payload.tool_choice?.type).toBe("tool");
		}
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

describe("Anthropic forced tool_choice with zero max tokens (issue #12597)", () => {
	it("floors max_tokens to 1 instead of sending a guaranteed 400", async () => {
		const payload = await capturePayload(makeAnthropicModel("claude-haiku-4-5"), {
			maxTokens: 0,
			toolChoice: { type: "tool", name: "yield" },
		});

		expect(payload.tool_choice?.type).toBe("tool");
		expect((payload as { max_tokens?: number }).max_tokens).toBe(1);
	});

	it("leaves an explicit positive budget untouched", async () => {
		const payload = await capturePayload(makeAnthropicModel("claude-haiku-4-5"), {
			maxTokens: 64,
			toolChoice: { type: "tool", name: "yield" },
		});

		expect((payload as { max_tokens?: number }).max_tokens).toBe(64);
	});
});
