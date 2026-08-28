import { afterEach, describe, expect, test, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	createCompactionSummaryMessage,
	defaultConvertToLlm,
	generateHandoff,
	generateHandoffFromContext,
	renderHandoffPrompt,
} from "@oh-my-pi/pi-agent-core/compaction";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import type { AssistantMessage, Model, ToolCall } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp: Date.now(),
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

function createAssistantError(errorStatus: number, errorMessage: string): AssistantMessage {
	return {
		...createAssistantMessage([]),
		stopReason: "error",
		errorStatus,
		errorMessage,
	};
}

const handoffToolSchema = type({ note: type("string").optional() });

function createHandoffTool(): AgentTool<typeof handoffToolSchema> {
	return {
		name: "handoff_probe",
		label: "Handoff Probe",
		description: "Confirms handoff requests keep live tools available.",
		parameters: handoffToolSchema,
		intent: "omit",
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
}

function getTestModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Expected built-in anthropic model to exist");
	}
	return model;
}

afterEach(() => {
	vi.restoreAllMocks();
});
describe("handoff summary injection", () => {
	// Regression: without handoff-specific framing the successor misreads the
	// document's first-person "Next Steps" as fresh user instructions, or tries
	// to write the handoff again.
	const document = "## Goal\nContinue the resize fix.\n\n## Next Steps\n1. Run the focused test";

	function convertedText(method: string | undefined): string {
		const message = createCompactionSummaryMessage(document, 1000, new Date().toISOString(), { method });
		const [converted] = defaultConvertToLlm([message]);
		if (!converted || !Array.isArray(converted.content)) throw new Error("Expected converted content blocks");
		const block = converted.content[0];
		if (block?.type !== "text") throw new Error("Expected leading text block");
		return block.text;
	}

	test("handoff-method summary is framed as the successor's own prior handoff", () => {
		const text = convertedText("handoff");
		expect(text).toContain("<handoff>");
		expect(text).toContain("prior instance");
		expect(text).toContain("NEVER write another handoff document");
		expect(text).toContain(document);
		expect(text).not.toContain("<summary>");
	});

	test("non-handoff methods keep the generic compaction framing", () => {
		const text = convertedText("remote");
		expect(text).toContain("<summary>");
		expect(text).toContain(document);
		expect(text).not.toContain("<handoff>");
	});
});

describe("handoff helpers", () => {
	test("renders custom focus into the handoff prompt", () => {
		const rendered = renderHandoffPrompt("preserve failing test name");
		expect(rendered).toContain("preserve failing test name");
	});

	test("generates handoff with the live cache prefix and tool use disabled", async () => {
		const strayToolCall: ToolCall = { type: "toolCall", id: "call_1", name: "read", arguments: {} };
		const completeSimpleSpy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(
				createAssistantMessage([
					{ type: "text", text: "## Goal\nContinue" },
					strayToolCall,
					{ type: "text", text: "## Next Steps\n1. Run the focused test" },
				]),
			);
		const model = getTestModel();
		const systemPrompt = ["Live system prompt"];
		const tools: AgentTool[] = [];
		const messages: AgentMessage[] = [
			{ role: "user", content: "start work", timestamp: 1 },
			createAssistantMessage([{ type: "text", text: "started" }]),
		];

		const document = await generateHandoff(messages, model, "test-key", {
			systemPrompt,
			tools,
			customInstructions: "preserve failing test name",
			initiatorOverride: "agent",
			metadata: { session: "handoff-test" },
		});

		expect(document).toBe("## Goal\nContinue\n## Next Steps\n1. Run the focused test");
		expect(completeSimpleSpy).toHaveBeenCalledTimes(1);
		const call = completeSimpleSpy.mock.calls[0];
		if (!call) throw new Error("Expected completeSimple call");
		const [calledModel, context, options] = call;
		expect(calledModel).toBe(model);
		expect(context.systemPrompt).toBe(systemPrompt);
		expect(context.tools).toBe(tools);
		expect(context.messages[0]).toMatchObject({ role: "user", content: "start work" });
		expect(options).toMatchObject({
			apiKey: "test-key",
			reasoning: Effort.High,
			toolChoice: "none",
			initiatorOverride: "agent",
			metadata: { session: "handoff-test" },
		});

		const lastMessage = context.messages[context.messages.length - 1];
		if (!lastMessage) throw new Error("Expected trailing handoff prompt message");
		if (lastMessage.role !== "user") {
			throw new Error("Expected trailing handoff prompt to be a user message");
		}
		expect(lastMessage.attribution).toBe("agent");
		if (!Array.isArray(lastMessage.content)) {
			throw new Error("Expected handoff prompt content blocks");
		}
		const promptBlock = lastMessage.content[0];
		if (promptBlock?.type !== "text") {
			throw new Error("Expected text handoff prompt block");
		}
		expect(promptBlock.text).toContain("preserve failing test name");
	});

	test("generateHandoffFromContext forwards cache routing and forces no-tools", async () => {
		const completeSimpleSpy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage([{ type: "text", text: "## Goal\nGo" }]));
		const model = getTestModel();
		const context = {
			systemPrompt: ["Live system prompt"],
			tools: [],
			messages: [{ role: "user" as const, content: "start work", timestamp: 1 }],
		};

		const document = await generateHandoffFromContext(context, model, {
			streamOptions: {
				apiKey: "test-key",
				sessionId: "sess-1:side:42",
				promptCacheKey: "sess-1",
				// Caller-provided reasoning/toolChoice must be overridden by the
				// handoff contract below.
				reasoning: Effort.Low,
				toolChoice: "auto",
			},
			thinkingLevel: ThinkingLevel.Medium,
		});

		expect(document).toBe("## Goal\nGo");
		const call = completeSimpleSpy.mock.calls[0];
		if (!call) throw new Error("Expected completeSimple call");
		const [calledModel, calledContext, options] = call;
		expect(calledModel).toBe(model);
		// Context is forwarded verbatim — the host already built the cache-matching prefix.
		expect(calledContext).toBe(context);
		expect(options).toMatchObject({
			apiKey: "test-key",
			sessionId: "sess-1:side:42",
			promptCacheKey: "sess-1",
			toolChoice: "none",
			reasoning: Effort.Medium,
		});
	});

	test("generateHandoffFromContext retries auto-only tool_choice rejection with live tools", async () => {
		const completeSimpleSpy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(
				createAssistantError(
					400,
					"400 Bad Request: Only a tool_choice of 'auto' is supported for this model; param=tool_choice",
				),
			)
			.mockResolvedValueOnce(createAssistantMessage([{ type: "text", text: "## Goal\nRecovered on retry" }]));
		const model = getTestModel();
		const tools = [createHandoffTool()];
		const context = {
			systemPrompt: ["Live system prompt"],
			tools,
			messages: [{ role: "user" as const, content: "prepare handoff", timestamp: 1 }],
		};

		const document = await generateHandoffFromContext(context, model, {
			streamOptions: {
				apiKey: "test-key",
				sessionId: "sess-auto-only:side:42",
				promptCacheKey: "sess-auto-only",
			},
			thinkingLevel: ThinkingLevel.Medium,
		});

		expect(document).toBe("## Goal\nRecovered on retry");
		expect(completeSimpleSpy).toHaveBeenCalledTimes(2);
		const firstCall = completeSimpleSpy.mock.calls[0];
		const secondCall = completeSimpleSpy.mock.calls[1];
		if (!firstCall) throw new Error("Expected initial completeSimple call");
		if (!secondCall) throw new Error("Expected retry completeSimple call");
		const [firstModel, firstContext, firstOptions] = firstCall;
		const [secondModel, secondContext, secondOptions] = secondCall;
		expect(firstModel).toBe(model);
		expect(secondModel).toBe(model);
		expect(firstContext).toBe(context);
		expect(secondContext).toBe(context);
		expect(firstContext.tools).toBe(tools);
		expect(secondContext.tools).toBe(tools);
		expect(firstOptions).toMatchObject({
			apiKey: "test-key",
			sessionId: "sess-auto-only:side:42",
			promptCacheKey: "sess-auto-only",
			toolChoice: "none",
			reasoning: Effort.Medium,
		});
		expect(secondOptions).toMatchObject({
			apiKey: "test-key",
			sessionId: "sess-auto-only:side:42",
			promptCacheKey: "sess-auto-only",
			toolChoice: "auto",
			reasoning: Effort.Medium,
		});
	});

	test("generateHandoffFromContext surfaces unrelated provider 400 without retrying", async () => {
		const completeSimpleSpy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(createAssistantError(400, "400 Bad Request: unsupported max_tokens; param=max_tokens"));
		const model = getTestModel();
		const tools = [createHandoffTool()];
		const context = {
			systemPrompt: ["Live system prompt"],
			tools,
			messages: [{ role: "user" as const, content: "prepare handoff", timestamp: 1 }],
		};

		const error = await generateHandoffFromContext(context, model, {
			streamOptions: {
				apiKey: "test-key",
				sessionId: "sess-unrelated-400:side:42",
				promptCacheKey: "sess-unrelated-400",
			},
			thinkingLevel: ThinkingLevel.Medium,
		}).catch((caught: unknown) => caught);

		if (!(error instanceof Error)) throw new Error("Expected handoff generation to reject");
		expect(error.message).toContain("unsupported max_tokens");
		expect(completeSimpleSpy).toHaveBeenCalledTimes(1);
		const call = completeSimpleSpy.mock.calls[0];
		if (!call) throw new Error("Expected completeSimple call");
		const [, calledContext, options] = call;
		expect(calledContext).toBe(context);
		expect(calledContext.tools).toBe(tools);
		expect(options).toMatchObject({
			apiKey: "test-key",
			sessionId: "sess-unrelated-400:side:42",
			promptCacheKey: "sess-unrelated-400",
			toolChoice: "none",
			reasoning: Effort.Medium,
		});
	});
});
