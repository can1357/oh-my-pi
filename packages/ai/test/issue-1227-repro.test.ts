/**
 * Repro for #1227 — `/btw` (and IRC background replies) fail with a
 * `BedrockException` once the session has tool-call history when the model is
 * served via LiteLLM → Bedrock.
 *
 * `AgentSession.runEphemeralTurn` calls into the openai-completions provider
 * with `context.tools = []` and `toolChoice: "none"`. The combination
 * serializes as `tool_choice: "none"` paired with `tools: []`, which LiteLLM
 * translates into a Bedrock `toolConfig` block with no entries. Bedrock then
 * rejects the request because the conversation already contains
 * `toolUse`/`toolResult` blocks and `toolConfig.tools` must be non-empty.
 *
 * The fix in `buildParams` drops `tool_choice: "none"` whenever the resolved
 * `tools` array is empty (logically redundant — there are no tools to gate).
 * The `tools: []` field stays so Anthropic-via-proxy still sees the field it
 * requires when tool history is present.
 */
import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { AssistantMessage, Context, Model, ModelSpec, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function bedrockModel(): Model<"openai-completions"> {
	const base = getBundledModel("openai", "gpt-4o-mini");
	return buildModel({
		...base,
		api: "openai-completions",
		id: "bedrock-claude-sonnet-4-6",
		name: "Bedrock Claude Sonnet 4.6 (LiteLLM)",
		provider: "litellm-bedrock",
		baseUrl: "https://example.test/v1",
		compat: base.compatConfig,
	} as ModelSpec<"openai-completions">);
}

async function capturePayload(
	context: Context,
	opts: Parameters<typeof streamOpenAICompletions>[2],
): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamOpenAICompletions(bedrockModel(), context, {
		...opts,
		apiKey: "test-key",
		signal: abortedSignal(),
		onPayload: payload => resolve(payload),
	});
	return (await promise) as Record<string, unknown>;
}

function assistantWithToolCall(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_1", name: "search", arguments: { q: "x" } }],
		api: "openai-completions",
		provider: "litellm-bedrock",
		model: "bedrock-claude-sonnet-4-6",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

const echoTool: Tool = {
	name: "echo",
	description: "Echo input",
	parameters: type({ text: "string" }),
};

describe("issue #1227 — /btw fails on LiteLLM→Bedrock with tool history", () => {
	it("omits both tools and tool_choice when /btw passes empty tools + toolChoice none", async () => {
		// Mirrors AgentSession.runEphemeralTurn: context.tools = [] is explicit
		// (prevents tool-catalog leakage in IRC replies) and toolChoice = "none".
		// `[]` is truthy, so buildParams used to land in the `if (context.tools)`
		// branch and emit `"tools": []` on the wire — LiteLLM → Bedrock then
		// translated that into an empty `toolConfig` block and Bedrock rejected
		// the request whenever the conversation already held toolUse/toolResult
		// content. The `.length` guard now skips the branch on empty arrays so
		// the wire body carries no `tools` field at all, which is the only shape
		// every downstream proxy accepts.
		const body = await capturePayload(
			{
				messages: [{ role: "user", content: "what is X", timestamp: Date.now() }],
				tools: [],
			},
			{ toolChoice: "none" },
		);

		expect(body.tools).toBeUndefined();
		expect(body.tool_choice).toBeUndefined();
	});

	it("omits both tools and tool_choice when /btw passes empty tools + has tool history", async () => {
		// The critical /btw scenario: session already has tool history (prior agentic
		// turn) AND context.tools = []. After the .length guard skips the first branch,
		// the caller-opted-out case must NOT fall through to the hasToolHistory sentinel
		// — that would still emit `"tools": []` and cause the same Bedrock rejection.
		// The `context.tools === undefined` guard on the second branch ensures we only
		// inject the Anthropic-proxy sentinel when tools were omitted entirely.
		const body = await capturePayload(
			{
				messages: [
					{ role: "user", content: "search now", timestamp: Date.now() },
					assistantWithToolCall(),
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "search",
						content: [{ type: "text", text: "result" }],
						isError: false,
						timestamp: Date.now(),
					},
					{ role: "user", content: "btw what is X", timestamp: Date.now() },
				],
				tools: [], // explicit opt-out, as AgentSession.runEphemeralTurn does
			},
			{ toolChoice: "none" },
		);

		expect(body.tools).toBeUndefined();
		expect(body.tool_choice).toBeUndefined();
	});

	it("drops tool_choice when tool history is present without explicit tools", async () => {
		// hasToolHistory() branch: no context.tools, but messages contain a prior
		// assistant toolCall — buildParams injects `tools: []` for Anthropic-proxy
		// compat, and toolChoice="none" must still be stripped to keep LiteLLM from
		// emitting a malformed Bedrock toolConfig.
		const body = await capturePayload(
			{
				messages: [
					{ role: "user", content: "search now", timestamp: Date.now() },
					assistantWithToolCall(),
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "search",
						content: [{ type: "text", text: "result" }],
						isError: false,
						timestamp: Date.now(),
					},
					{ role: "user", content: "follow-up", timestamp: Date.now() },
				],
			},
			{ toolChoice: "none" },
		);

		expect(body.tools).toEqual([]);
		expect(body.tool_choice).toBeUndefined();
	});

	it("keeps tool_choice none when real tools are present", async () => {
		// Sanity: with non-empty tools, tool_choice="none" is legal Bedrock input
		// (toolConfig has entries) and must still be forwarded so the model knows
		// it should not call any tool this turn.
		const body = await capturePayload(
			{
				messages: [{ role: "user", content: "answer in prose", timestamp: Date.now() }],
				tools: [echoTool],
			},
			{ toolChoice: "none" },
		);

		expect(Array.isArray(body.tools)).toBe(true);
		expect((body.tools as unknown[]).length).toBe(1);
		expect(body.tool_choice).toBe("none");
	});
});
