/**
 * Issue #1838 — `kimik2 stops in between requests`.
 *
 * Moonshot's Kimi K2.6 endpoint extends the `thinking` parameter with a `keep`
 * field that controls whether the SERVER preserves `reasoning_content` from
 * historical assistant turns across multi-step tool calls. From Moonshot's
 * official docs (https://platform.moonshot.ai/docs/guide/use-kimi-k2-thinking-model):
 *
 *   > `null` (default) or omitted: The server ignores reasoning_content from
 *   >   historical turns.
 *   > `"all"`: Preserves reasoning_content from historical turns and provides
 *   >   it to the model as part of the context, enabling Preserved Thinking.
 *   >   Recommended to use together with `type: "enabled"`.
 *
 * And in the K2.6 multi-step-tool-call best-practices section:
 *
 *   > kimi-k2.6 (with thinking enabled) is designed to perform deep reasoning
 *   > across multiple tool calls … To get reliable results, always …  include
 *   > the entire reasoning content from the context.
 *
 * Without `keep: "all"` the Moonshot backend silently drops every prior turn's
 * `reasoning_content` even though omp already sends it on the wire (the Kimi
 * compat path sets `requiresReasoningContentForToolCalls`). K2.6 then has to
 * re-derive its full chain-of-thought from the user prompt on every iteration
 * of an agent loop, which the reporter sees as the agent "stops in between
 * one its requests and does not proceed" while the next reasoning phase
 * silently churns server-side.
 *
 * The fix sends `thinking: { type: "enabled", keep: "all" }` to native
 * Moonshot / Kimi-code K2.6 endpoints. The field is K2.6-only — K2.5 and
 * earlier 400 on unknown fields — and Moonshot-host-only — every gateway
 * (OpenRouter, OpenCode, Kilo, Fireworks, …) translates thinking into its
 * own native format and would reject the extra key.
 */
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { AssistantMessage, Context, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function sseDoneResponse(): Response {
	return new Response("data: [DONE]\n\n", {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function mockFetch(): FetchImpl {
	const fn = async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => sseDoneResponse();
	return Object.assign(fn, { preconnect: fetch.preconnect });
}

function moonshotKimiModel(id: string, reasoning = true): Model<"openai-completions"> {
	const base = getBundledModel("openai", "gpt-4o-mini");
	return buildModel({
		...base,
		api: "openai-completions",
		provider: "moonshot",
		baseUrl: "https://api.moonshot.ai/v1",
		id,
		reasoning,
		compat: base.compatConfig,
	} as ModelSpec<"openai-completions">);
}

function openRouterKimiModel(id: string): Model<"openai-completions"> {
	const base = getBundledModel("openai", "gpt-4o-mini");
	return buildModel({
		...base,
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		id,
		reasoning: true,
		compat: base.compatConfig,
	} as ModelSpec<"openai-completions">);
}

function basicContext(): Context {
	return {
		messages: [{ role: "user", content: "Build a flight sim dashboard", timestamp: Date.now() }],
	};
}

async function capturePayload(
	model: Model<"openai-completions">,
	opts: Parameters<typeof streamOpenAICompletions>[2],
	context: Context = basicContext(),
): Promise<unknown> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamOpenAICompletions(model, context, {
		apiKey: "test-key",
		signal: abortedSignal(),
		onPayload: payload => resolve(payload),
		...opts,
		fetch: mockFetch(),
	});
	return promise;
}

interface CompletionAssistantWireMessage {
	role: "assistant";
	reasoning_content?: unknown;
}

interface CompletionBody {
	thinking?: { type?: string; keep?: string };
	messages?: unknown[];
	stream?: boolean;
}

function isCompletionAssistantWireMessage(message: unknown): message is CompletionAssistantWireMessage {
	if (typeof message !== "object" || message === null) return false;
	return (message as { role?: unknown }).role === "assistant";
}

function findCompletionAssistantWireMessage(
	messages: readonly unknown[] | undefined,
): CompletionAssistantWireMessage | undefined {
	return messages?.find(isCompletionAssistantWireMessage);
}

describe("issue #1838 — kimi-k2.6 preserves historical reasoning across tool calls", () => {
	it("sends thinking.keep='all' on native Moonshot kimi-k2.6 when reasoning is enabled", async () => {
		const payload = (await capturePayload(moonshotKimiModel("kimi-k2.6"), { reasoning: "high" })) as CompletionBody;
		expect(payload.thinking).toEqual({ type: "enabled", keep: "all" });
	});

	it("preserves the Moonshot-native gate against gateway IDs that match the kimi-k2.6 prefix", async () => {
		// Sanity: the Moonshot-native gate is provider+baseUrl driven, not id-only.
		// A made-up host with `kimi-k2.6` in the id but a non-Moonshot baseUrl must
		// never get the Moonshot-only `keep` parameter on the wire.
		const base = getBundledModel("openai", "gpt-4o-mini");
		const customModel: Model<"openai-completions"> = buildModel({
			...base,
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://example.com/v1",
			id: "kimi-k2.6",
			reasoning: true,
			compat: base.compatConfig,
		} as ModelSpec<"openai-completions">);
		const payload = (await capturePayload(customModel, { reasoning: "high" })) as CompletionBody;
		expect(payload.thinking).toBeUndefined();
	});

	it("does NOT send thinking.keep on kimi-k2.5 (field is K2.6-only in Moonshot's schema)", async () => {
		const payload = (await capturePayload(moonshotKimiModel("kimi-k2.5"), { reasoning: "high" })) as CompletionBody;
		expect(payload.thinking).toBeDefined();
		expect(payload.thinking?.type).toBe("enabled");
		expect(payload.thinking?.keep).toBeUndefined();
	});

	it("does NOT send thinking.keep on Moonshot kimi-k2.6 when disableReasoning is set", async () => {
		// disableReasoning + a non-truthy `reasoning` flag flips thinking to
		// `{ type: "disabled" }`. Sending `keep: "all"` alongside `disabled`
		// preserves history the model is told to ignore — useless extra bytes
		// and also outside Moonshot's documented best practice (which pairs
		// `keep: "all"` with `type: "enabled"`).
		const payload = (await capturePayload(moonshotKimiModel("kimi-k2.6"), {
			disableReasoning: true,
		})) as CompletionBody;
		expect(payload.thinking).toEqual({ type: "disabled" });
	});

	it("does NOT send thinking.keep on OpenRouter-hosted Kimi K2.6 (proxy uses its own thinking shape)", async () => {
		// OpenRouter uses `reasoning: { effort }` rather than Moonshot's
		// `thinking: { type, keep }`. The compat detector classifies this path
		// as `thinkingFormat: "openrouter"` and leaves `thinkingKeep` unset.
		const payload = (await capturePayload(openRouterKimiModel("moonshotai/kimi-k2.6"), {
			reasoning: "high",
		})) as CompletionBody;
		expect(payload.thinking).toBeUndefined();
	});

	it("does NOT send thinking.keep on a forced-tool turn (compat disables thinking entirely for Kimi)", async () => {
		// `disableReasoningOnForcedToolChoice` flips thinking to `disabled`
		// for Kimi-family models whenever the request forces a named tool
		// call (Moonshot 400s with `tool_choice 'specified' is incompatible
		// with thinking enabled` otherwise — see #827). `keep: "all"` MUST NOT
		// resurrect on this path.
		const payload = (await capturePayload(
			moonshotKimiModel("kimi-k2.6"),
			{
				reasoning: "high",
				toolChoice: { type: "tool", name: "read" },
			},
			{
				messages: [{ role: "user", content: "Use the read tool", timestamp: Date.now() }],
				tools: [
					{
						name: "read",
						description: "read a file",
						parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
					},
				],
			},
		)) as CompletionBody;
		expect(payload.thinking).toEqual({ type: "disabled" });
	});

	it("survives kimi-k2.6 ids that include a routing suffix (Fireworks-style)", async () => {
		// Fireworks publishes Kimi K2.6 under the `accounts/fireworks/routers/`
		// namespace. The `keep` flag is Moonshot-specific, so a Fireworks-hosted
		// K2.6 (which never speaks the Moonshot wire) must not see it.
		const base = getBundledModel("openai", "gpt-4o-mini");
		const fireworksModel: Model<"openai-completions"> = buildModel({
			...base,
			api: "openai-completions",
			provider: "fireworks",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			id: "accounts/fireworks/routers/kimi-k2.6",
			reasoning: true,
			compat: base.compatConfig,
		} as ModelSpec<"openai-completions">);
		const payload = (await capturePayload(fireworksModel, { reasoning: "high" })) as CompletionBody;
		// Fireworks → reasoning_effort path; thinking object never set.
		expect(payload.thinking).toBeUndefined();
	});

	it("preserves the streamed assistant flow alongside thinking.keep='all'", async () => {
		// Sanity: the rest of the request body is unchanged when keep is set —
		// `stream` stays true and the prior assistant reasoning_content still
		// rides on the wire (the existing `requiresReasoningContentForToolCalls`
		// path) so the server's `keep: "all"` has data to preserve.
		const priorAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Need to read the file first.", thinkingSignature: "reasoning_content" },
				{ type: "toolCall", id: "call_abc", name: "read", arguments: { path: "README.md" } },
			],
			api: "openai-completions",
			provider: "moonshot",
			model: "kimi-k2.6",
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
		const payload = (await capturePayload(
			moonshotKimiModel("kimi-k2.6"),
			{ reasoning: "high" },
			{
				messages: [
					{ role: "user", content: "Summarize README", timestamp: Date.now() },
					priorAssistant,
					{
						role: "toolResult",
						toolCallId: "call_abc",
						toolName: "read",
						content: [{ type: "text", text: "# Hello\n" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
		)) as CompletionBody;
		expect(payload.thinking).toEqual({ type: "enabled", keep: "all" });
		expect(payload.stream).toBe(true);
		const assistant = findCompletionAssistantWireMessage(payload.messages);
		expect(assistant).toBeDefined();
		expect(assistant?.reasoning_content).toBe("Need to read the file first.");
	});
});
