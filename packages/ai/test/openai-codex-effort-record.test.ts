// `AssistantMessage.effort` is the provider-neutral record of the reasoning
// effort a non-Anthropic request actually put on the wire (post-clamp) — the
// counterpart Anthropic routes carry in `requestControls.effort`. Anthropic
// routes are out of scope here: these cases cover `openai-codex-responses` and
// `openai-responses`, whose effort is only ever computed inside the request
// encoder, so the terminal `done` message must copy it back off the encoded
// params. Fixtures use explicit thinking ladders and neutral ids so catalog
// detection cannot interfere.
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	streamOpenAICodexResponses,
	type OpenAICodexResponsesOptions,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { __resetProxyCache } from "@oh-my-pi/pi-ai/utils/proxy";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import * as piUtils from "@oh-my-pi/pi-utils";

const TEST_INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";

const testContext: Context = {
	systemPrompt: ["Say hello."],
	messages: [{ role: "user", content: "Say hello", timestamp: 0 }],
};

const CODEX_SPEC: ModelSpec<"openai-codex-responses"> = {
	id: "record-codex-effort",
	name: "Record Codex Effort",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	preferWebsockets: false,
	thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max] },
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272000,
	maxTokens: 128000,
};

const RESPONSES_SPEC: ModelSpec<"openai-responses"> = {
	id: "record-responses-effort",
	name: "Record Responses Effort",
	api: "openai-responses",
	provider: "custom-responses",
	baseUrl: "https://responses.example.test/v1",
	reasoning: true,
	compat: { supportsReasoningParams: true, supportsReasoningEffort: true },
	thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
};

const COMPLETED_CODEX_SSE = `${[
	`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
	`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
	`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello" }] } })}`,
	`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
].join("\n\n")}\n\n`;

const RESPONSES_SSE = `${[
	{
		type: "response.output_item.added",
		output_index: 0,
		item: { type: "message", id: "msg_record", role: "assistant", content: [] },
	},
	{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
	{ type: "response.output_text.delta", delta: "ok" },
	{
		type: "response.output_item.done",
		output_index: 0,
		item: { type: "message", id: "msg_record", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
	},
	{
		type: "response.completed",
		response: {
			status: "completed",
			usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
		},
	},
]
	.map(event => `data: ${JSON.stringify(event)}`)
	.join("\n\n")}\n\n`;

const codexFetch = (async () =>
	new Response(COMPLETED_CODEX_SSE, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	})) as unknown as FetchImpl;
const responsesFetch = (async () =>
	new Response(RESPONSES_SSE, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	})) as unknown as FetchImpl;

beforeEach(() => {
	__resetProxyCache();
	vi.spyOn(piUtils, "getInstallId").mockReturnValue(TEST_INSTALLATION_ID);
});

afterEach(() => {
	__resetProxyCache();
	vi.restoreAllMocks();
});

function createCodexTestToken(accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

function rejectedReasoningEffortResponse(value: string): Response {
	return new Response(
		JSON.stringify({
			error: {
				message: `invalid reasoning value: '${value}' (must be "high", "medium", "low", "max", or "none")`,
				type: "invalid_request_error",
				param: "reasoning.effort",
			},
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
}

/** Codex turn over SSE with the model spec and effort knobs the case needs. */
function runCodex(
	spec: Partial<ModelSpec<"openai-codex-responses">>,
	options: Pick<OpenAICodexResponsesOptions, "reasoning" | "forceReasoningOff">,
) {
	return streamOpenAICodexResponses(buildModel<"openai-codex-responses">({ ...CODEX_SPEC, ...spec }), testContext, {
		apiKey: createCodexTestToken(),
		fetch: codexFetch,
		...options,
	}).result();
}

/** Plain Responses turn, optionally over a retrying fetch for the fallback case. */
function runResponses(options: { reasoning?: Effort; forceReasoningOff?: boolean; fetch?: FetchImpl }) {
	return streamOpenAIResponses(buildModel<"openai-responses">(RESPONSES_SPEC), testContext, {
		apiKey: "test-key",
		...options,
		fetch: options.fetch ?? responsesFetch,
	}).result();
}

describe("AssistantMessage.effort records the sent effort", () => {
	describe("openai-codex-responses", () => {
		it("records the selected tier", async () => {
			const result = await runCodex({}, { reasoning: "low" });

			expect(result.stopReason).toBe("stop");
			expect(result.effort).toBe(Effort.Low);
		});

		it("records the tier the model's effort map clamped the selector onto", async () => {
			// `high` passes `requireSupportedEffort` but the model's effort map
			// reroutes it: what the backend received is `medium`.
			const result = await runCodex(
				{
					thinking: {
						mode: "effort",
						efforts: [Effort.Low, Effort.Medium, Effort.High],
						effortMap: { [Effort.High]: "medium" },
					},
				},
				{ reasoning: "high" },
			);

			expect(result.stopReason).toBe("stop");
			expect(result.effort).toBe(Effort.Medium);
		});

		it('records "none" when reasoning is forced off', async () => {
			const result = await runCodex({}, { reasoning: "high", forceReasoningOff: true });

			expect(result.stopReason).toBe("stop");
			expect(result.effort).toBe("none");
		});

		it("stays absent when the request sends no effort", async () => {
			const result = await runCodex({}, {});

			expect(result.stopReason).toBe("stop");
			expect(result.effort).toBeUndefined();
		});
	});

	describe("openai-responses", () => {
		it("records the selected tier", async () => {
			const result = await runResponses({ reasoning: Effort.Low });

			expect(result.stopReason).toBe("stop");
			expect(result.effort).toBe(Effort.Low);
		});

		it('records "none" when reasoning is forced off', async () => {
			const result = await runResponses({ reasoning: Effort.High, forceReasoningOff: true });

			expect(result.stopReason).toBe("stop");
			expect(result.effort).toBe("none");
		});

		it("records the tier a reasoning-effort fallback retry downgraded to", async () => {
			const bodies: Record<string, unknown>[] = [];
			const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
				bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>);
				return bodies.length === 1
					? rejectedReasoningEffortResponse("xhigh")
					: new Response(RESPONSES_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
			}) as unknown as FetchImpl;

			const result = await runResponses({ reasoning: Effort.XHigh, fetch: fetchMock });

			expect(result.stopReason).toBe("stop");
			expect(bodies.map(body => (body.reasoning as { effort?: string } | undefined)?.effort)).toEqual([
				"xhigh",
				"max",
			]);
			// The recorded tier is the one the successful attempt sent, not the rejected selector.
			expect(result.effort).toBe(Effort.Max);
		});
	});
});
