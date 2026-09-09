/**
 * Issue #2113 — `kimik2 does not work on the latest omp`
 *
 * Reporter: with only `MOONSHOT_API_KEY` set, selecting `kimi-k2.6` and
 * sending any text leaves the agent stuck on "Working..." with no output.
 *
 * Root cause: the `moonshot` provider only bundled `kimi-k2.5`, and the
 * `moonshotModelManagerOptions` discovery mapper only promoted ids
 * containing `"thinking"` to `reasoning: true`. `kimi-k2.6` fell through
 * with `reasoning: false`, so the openai-completions `buildParams` z.ai
 * branch was skipped entirely and Moonshot received a request with no
 * `thinking` parameter — Moonshot K2.6 stalls under that shape (the same
 * native-API quirk documented in the #1838 fix that introduced
 * `thinking.keep` for K2.6).
 *
 * The fix marks every `kimi-k2.x` id as reasoning + vision in the
 * moonshot discovery mapper and stamps default thinking metadata.
 */
import { describe, expect, it } from "bun:test";
import { type OpenAICompletionsOptions, streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { moonshotModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";

function moonshotKimiModel(id: string, reasoning: boolean): Model<"openai-completions"> {
	const reference = getBundledModel("openai", "gpt-4o-mini");
	// Derive a variant from the built bundled model: sparse compat comes from
	// `compatConfig`; `buildModel` re-resolves it for the Moonshot host.
	return buildModel({
		...reference,
		api: "openai-completions",
		provider: "moonshot",
		baseUrl: "https://api.moonshot.ai/v1",
		id,
		reasoning,
		compat: reference.compatConfig,
	} as ModelSpec<"openai-completions">);
}

function basicContext(): Context {
	return {
		messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
	};
}

function encodeSseChunks(chunks: ReadonlyArray<Record<string, unknown>>): string {
	const lines = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`);
	lines.push("data: [DONE]\n\n");
	return lines.join("");
}

function buildMockMoonshotResponse(): Response {
	const body = encodeSseChunks([
		{
			id: "chatcmpl-k26-1",
			object: "chat.completion.chunk",
			created: 1,
			model: "kimi-k2.6",
			choices: [{ index: 0, delta: { role: "assistant", content: "Hello!" }, finish_reason: null }],
		},
		{
			id: "chatcmpl-k26-1",
			object: "chat.completion.chunk",
			created: 1,
			model: "kimi-k2.6",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		},
	]);
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

interface CapturedRequest {
	url: string;
	body: Record<string, unknown>;
}

async function runHiTurn(
	model: Model<"openai-completions">,
	options?: Pick<OpenAICompletionsOptions, "reasoning">,
): Promise<{ captured: CapturedRequest; assistant: AssistantMessage }> {
	const captured: CapturedRequest = { url: "", body: {} };
	const fetchMock = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		captured.url = url;
		const raw = typeof init?.body === "string" ? init.body : "";
		captured.body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
		return buildMockMoonshotResponse();
	}) as typeof fetch;

	const stream = streamOpenAICompletions(model, basicContext(), { apiKey: "test-key", fetch: fetchMock, ...options });
	for await (const _ of stream) {
		// drain until terminal event
	}
	const assistant = await stream.result();
	return { captured, assistant };
}

describe("issue #2113 — moonshot kimi-k2.6 discovery and wire format", () => {
	it("moonshot discovery mapper marks kimi-k2.6 as reasoning + vision with thinking metadata", async () => {
		const fetchMock = (async (input: string | URL | Request): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			expect(url).toContain("api.moonshot.ai/v1/models");
			const body = {
				object: "list",
				data: [
					{ id: "kimi-k2.5", object: "model", owned_by: "moonshot" },
					{ id: "kimi-k2.6", object: "model", owned_by: "moonshot" },
					{ id: "kimi-k2-thinking", object: "model", owned_by: "moonshot" },
				],
			};
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;

		const models = await moonshotModelManagerOptions({ apiKey: "test-key", fetch: fetchMock }).fetchDynamicModels?.();
		expect(models).toBeDefined();
		const byId = new Map(models?.map(m => [m.id, m]));

		const k25 = byId.get("kimi-k2.5");
		expect(k25?.reasoning).toBe(true);
		expect(k25?.input).toEqual(["text", "image"]);
		expect(k25?.thinking).toBeDefined();

		const k26 = byId.get("kimi-k2.6");
		expect(k26?.reasoning).toBe(true);
		expect(k26?.input).toEqual(["text", "image"]);
		expect(k26?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		});

		const thinkingOnly = byId.get("kimi-k2-thinking");
		expect(thinkingOnly?.reasoning).toBe(true);
		expect(thinkingOnly?.thinking).toBeDefined();
	});

	it("wire body for moonshot kimi-k2.6 carries an explicit thinking parameter", async () => {
		// The discovery mapper now stamps reasoning=true on Moonshot K2.6, so the
		// openai-completions z.ai branch fires and emits `thinking: {type}`. Without
		// this, Moonshot K2.6 stalls on first turn (the original #2113 symptom).
		const model = moonshotKimiModel("kimi-k2.6", true);
		const { captured, assistant } = await runHiTurn(model);

		expect(captured.url).toContain("api.moonshot.ai/v1/chat/completions");
		expect(captured.body.thinking).toEqual({ type: "disabled" });
		expect(assistant.errorMessage).toBeUndefined();
		const textBlock = assistant.content.find(b => b.type === "text");
		expect(textBlock).toBeDefined();
	});

	it("uses Moonshot-native max_tokens and omits OpenAI store control", async () => {
		const model = moonshotKimiModel("kimi-k2.5", true);
		const { captured } = await runHiTurn(model, { reasoning: "high" });

		expect(captured.body.max_tokens).toBeDefined();
		expect(captured.body.max_completion_tokens).toBeUndefined();
		expect(captured.body.store).toBeUndefined();
	});
	it("wire body includes thinking.keep='all' when reasoning is explicitly requested", async () => {
		const model = moonshotKimiModel("kimi-k2.6", true);
		const captured: CapturedRequest = { url: "", body: {} };
		const fetchMock = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			captured.url = url;
			const raw = typeof init?.body === "string" ? init.body : "";
			captured.body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
			return buildMockMoonshotResponse();
		}) as typeof fetch;

		const stream = streamOpenAICompletions(model, basicContext(), {
			apiKey: "test-key",
			reasoning: "high",
			fetch: fetchMock,
		});
		for await (const _ of stream) {
			// drain
		}

		expect(captured.body.thinking).toEqual({ type: "enabled", keep: "all" });
	});
});
