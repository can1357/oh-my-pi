import { describe, expect, it } from "bun:test";
import { convertCodexResponsesMessages } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { ResponseInput } from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import { buildResponsesInput } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { AssistantMessage, Context, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai/types";
import { createOpenAIResponsesHistoryPayload } from "@oh-my-pi/pi-ai/utils";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { createCodexModel } from "./helpers";

// Literal Harmony analysis-channel marker. openai-codex/gpt-5.x reject any
// request whose input carries this reserved control-token spelling as data
// (invalid_prompt / "Request blocked"), permanently poisoning the session.
const MARKER = "<|channel|>analysis";
const ESCAPED = "<\\|channel\\|>analysis";
// JSON-encoded spelling of ESCAPED as it appears inside a `function_call.arguments`
// document (the JSON-preserving escape doubles the backslash).
const ESCAPED_JSON = "<\\\\|channel\\\\|>analysis";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function harmonyPoisonedContext(): { context: Context; user: UserMessage; toolResult: ToolResultMessage } {
	const user: UserMessage = {
		role: "user",
		timestamp: 0,
		content: `please summarize ${MARKER} marker`,
	};
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_1", name: "grep", arguments: { pattern: "channel" } }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 0,
	};
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "grep",
		isError: false,
		content: [{ type: "text", text: `omp://toolconv/harmony.md: ${MARKER}\nmore docs` }],
		timestamp: 0,
	};
	return { context: { messages: [user, assistant, toolResult] }, user, toolResult };
}

/** Flatten every free-text field an openai-responses input item can carry. */
function collectWireText(items: ResponseInput): string {
	const parts: string[] = [];
	for (const item of items) {
		if ("output" in item && typeof item.output === "string") parts.push(item.output);
		if ("arguments" in item && typeof item.arguments === "string") parts.push(item.arguments);
		if ("input" in item && typeof item.input === "string") parts.push(item.input);
		if ("content" in item) {
			const content = item.content;
			if (typeof content === "string") {
				parts.push(content);
			} else if (Array.isArray(content)) {
				for (const part of content) {
					if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
						parts.push(part.text);
					}
				}
			}
		}
	}
	return parts.join("\n");
}

describe("issue #6913: Harmony control-token escaping at the request boundary", () => {
	it("escapes markers in codex user text and tool results without mutating persisted history", () => {
		const model = createCodexModel("gpt-5.6-sol");
		const { context, user, toolResult } = harmonyPoisonedContext();

		const wire = collectWireText(convertCodexResponsesMessages(model, context));

		expect(wire).toContain(ESCAPED);
		expect(wire).not.toContain(MARKER);

		// Persisted messages must stay byte-for-byte identical.
		expect(user.content).toBe(`please summarize ${MARKER} marker`);
		expect(toolResult.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(MARKER) });
	});

	it("escapes markers on the shared openai-responses builder for harmony models", () => {
		const model = buildModel({
			id: "gpt-5.6",
			name: "gpt-5.6",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272000,
			maxTokens: 128000,
		});
		const { context } = harmonyPoisonedContext();

		const wire = collectWireText(
			buildResponsesInput({ model, context, strictResponsesPairing: false, supportsImageDetailOriginal: false }),
		);

		expect(wire).toContain(ESCAPED);
		expect(wire).not.toContain(MARKER);
	});

	it("leaves non-harmony models (anthropic family) untouched", () => {
		const model = buildModel({
			id: "claude-sonnet-4",
			name: "claude-sonnet-4",
			api: "openai-responses",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 64000,
		});
		const { context } = harmonyPoisonedContext();

		const wire = collectWireText(
			buildResponsesInput({ model, context, strictResponsesPairing: false, supportsImageDetailOriginal: false }),
		);

		expect(wire).toContain(MARKER);
	});

	it("detects Harmony via the wire model id for deployment/catalog aliases", () => {
		// Opaque local id, gpt-5.4 on the wire (Azure-style alias). The gate must
		// resolve `requestModelId`, not the non-Harmony local id.
		const model = buildModel({
			id: "my-azure-deployment",
			requestModelId: "gpt-5.4",
			name: "my-azure-deployment",
			api: "openai-responses",
			provider: "azure",
			baseUrl: "https://example.openai.azure.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272000,
			maxTokens: 128000,
		});
		const { context } = harmonyPoisonedContext();

		const wire = collectWireText(
			buildResponsesInput({ model, context, strictResponsesPairing: false, supportsImageDetailOriginal: false }),
		);

		expect(wire).toContain(ESCAPED);
		expect(wire).not.toContain(MARKER);
	});

	it("escapes replayed native-history input items carrying a raw marker", () => {
		const model = buildModel({
			id: "gpt-5.6",
			name: "gpt-5.6",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272000,
			maxTokens: 128000,
		});
		// A stored client turn replayed verbatim via providerPayload — the branch
		// that bypasses convertResponsesInputContent entirely.
		const user: UserMessage = {
			role: "user",
			timestamp: 0,
			content: "continue",
			providerPayload: createOpenAIResponsesHistoryPayload("openai", [
				{ type: "message", role: "user", content: [{ type: "input_text", text: `stored ${MARKER} turn` }] },
				{ type: "function_call_output", call_id: "call_x", output: `tool said ${MARKER}` },
			]),
		};

		const wire = collectWireText(
			buildResponsesInput({
				model,
				context: { messages: [user] },
				strictResponsesPairing: false,
				supportsImageDetailOriginal: false,
				nativeHistory: { replay: true, filterReasoning: false },
			}),
		);

		expect(wire).toContain(ESCAPED);
		expect(wire).not.toContain(MARKER);
	});

	it("escapes replayed EasyInputMessage items that omit the type field", () => {
		const model = buildModel({
			id: "gpt-5.6",
			name: "gpt-5.6",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272000,
			maxTokens: 128000,
		});
		// Documented EasyInputMessage shape: `{ role, content }` with no `type`.
		// The responses server persists it verbatim into providerPayload.
		const user: UserMessage = {
			role: "user",
			timestamp: 0,
			content: "continue",
			providerPayload: createOpenAIResponsesHistoryPayload("openai", [
				{ role: "user", content: [{ type: "input_text", text: `typeless ${MARKER} turn` }] },
			]),
		};

		const wire = collectWireText(
			buildResponsesInput({
				model,
				context: { messages: [user] },
				strictResponsesPairing: false,
				supportsImageDetailOriginal: false,
				nativeHistory: { replay: true, filterReasoning: false },
			}),
		);

		expect(wire).toContain(ESCAPED);
		expect(wire).not.toContain(MARKER);
	});

	it("escapes model-authored tool-call arguments in replayed codex assistant history", () => {
		const model = createCodexModel("gpt-5.6-sol");
		// The model wrote an article *about* Harmony: its own stored function_call
		// arguments legitimately contain reserved control-token spellings.
		const storedArguments = JSON.stringify({ path: "post.md", content: `intro ${MARKER} outro` });
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call_w", name: "write", arguments: { path: "post.md" } }],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			usage: ZERO_USAGE,
			stopReason: "stop",
			timestamp: 0,
			providerPayload: createOpenAIResponsesHistoryPayload("openai-codex", [
				{ type: "function_call", call_id: "call_w", name: "write", arguments: storedArguments },
			]),
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_w",
			toolName: "write",
			isError: false,
			content: [{ type: "text", text: "wrote post.md" }],
			timestamp: 0,
		};

		const items = convertCodexResponsesMessages(model, { messages: [assistant, toolResult] });
		expect(collectWireText(items)).not.toContain(MARKER);

		// Arguments must stay a valid JSON document that decodes to the inert spelling.
		let argumentsOnWire = "";
		for (const item of items) {
			if (item.type === "function_call") argumentsOnWire = item.arguments;
		}
		expect(argumentsOnWire).toContain(ESCAPED_JSON);
		expect(JSON.parse(argumentsOnWire).content).toContain(ESCAPED);
	});

	it("escapes assistant fallback text and tool-call arguments for harmony models", () => {
		const model = createCodexModel("gpt-5.6-sol");
		// No native providerPayload — the block re-encode path used by
		// full-transcript retries and cross-provider fallback.
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: `draft ${MARKER} section` },
				{ type: "toolCall", id: "call_2", name: "write", arguments: { content: `body ${MARKER}` } },
			],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			usage: ZERO_USAGE,
			stopReason: "stop",
			timestamp: 0,
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_2",
			toolName: "write",
			isError: false,
			content: [{ type: "text", text: "ok" }],
			timestamp: 0,
		};

		const wire = collectWireText(convertCodexResponsesMessages(model, { messages: [assistant, toolResult] }));
		expect(wire).toContain(ESCAPED);
		expect(wire).toContain(ESCAPED_JSON);
		expect(wire).not.toContain(MARKER);
	});

	it("leaves model-authored arguments untouched for non-harmony models", () => {
		const model = buildModel({
			id: "claude-sonnet-4",
			name: "claude-sonnet-4",
			api: "openai-responses",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 64000,
		});
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call_2", name: "write", arguments: { content: `body ${MARKER}` } }],
			api: "openai-responses",
			provider: "openrouter",
			model: "claude-sonnet-4",
			usage: ZERO_USAGE,
			stopReason: "stop",
			timestamp: 0,
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_2",
			toolName: "write",
			isError: false,
			content: [{ type: "text", text: "ok" }],
			timestamp: 0,
		};

		const wire = collectWireText(
			buildResponsesInput({
				model,
				context: { messages: [assistant, toolResult] },
				strictResponsesPairing: false,
				supportsImageDetailOriginal: false,
			}),
		);
		expect(wire).toContain(MARKER);
	});
});
