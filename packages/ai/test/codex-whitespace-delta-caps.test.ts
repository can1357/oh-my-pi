import { describe, expect, it } from "bun:test";
import {
	resolveCodexWhitespaceDeltaCaps,
	streamOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { withEnv } from "./helpers";

const DEFAULTS = { events: 256, chars: 16 * 1024 };

/** An SSE response whose only tool call streams `deltaCount` whitespace arguments. */
function whitespaceDeltaSse(deltaCount: number): string {
	const events: Array<Record<string, unknown>> = [
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "function_call", id: "fc_cap", call_id: "call_cap", name: "todo", arguments: "" },
		},
		...Array.from({ length: deltaCount }, (_, index) => ({
			type: "response.function_call_arguments.delta",
			output_index: 0,
			item_id: "fc_cap",
			delta: " ",
			sequence_number: index + 2,
		})),
		{
			type: "response.completed",
			response: {
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
	return `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
}

async function runWhitespaceStream(deltaCount: number) {
	const model = buildModel({
		id: "gpt-5.3-codex",
		name: "GPT-5.3 Codex",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://gateway.example/backend-api",
		reasoning: true,
		preferWebsockets: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 128_000,
	} as ModelSpec<"openai-codex-responses">);
	const sse = whitespaceDeltaSse(deltaCount);
	return await streamOpenAICodexResponses(
		model,
		{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
		{
			apiKey: "opaque-gateway-key",
			fetch: (async () =>
				new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as never,
		},
	).result();
}

describe("Codex whitespace-delta caps", () => {
	it("keeps the shipped defaults when neither cap is configured", () => {
		expect(resolveCodexWhitespaceDeltaCaps({})).toEqual(DEFAULTS);
	});

	it("honors both overrides", () => {
		expect(
			resolveCodexWhitespaceDeltaCaps({
				PI_CODEX_WHITESPACE_DELTA_EVENT_LIMIT: "4096",
				PI_CODEX_WHITESPACE_DELTA_CHAR_LIMIT: "1048576",
			}),
		).toEqual({ events: 4096, chars: 1048576 });
	});

	it("ignores values that are not whole positive decimal integers", () => {
		// A partially numeric value must keep the shipped cap: `parseInt` would read
		// `1e3` as 1 and `12abc` as 12, shrinking the cap instead of ignoring it.
		for (const value of ["", " ", "0", "-5", "1e3", "12abc", "0x20", "Infinity"]) {
			expect(
				resolveCodexWhitespaceDeltaCaps({
					PI_CODEX_WHITESPACE_DELTA_EVENT_LIMIT: value,
					PI_CODEX_WHITESPACE_DELTA_CHAR_LIMIT: value,
				}),
			).toEqual(DEFAULTS);
		}
	});

	it("interrupts a keep-alive stream once the configured cap is reached", async () => {
		await withEnv(
			{ PI_CODEX_WHITESPACE_DELTA_EVENT_LIMIT: "8", PI_CODEX_WHITESPACE_DELTA_CHAR_LIMIT: String(16 * 1024) },
			async () => {
				const result = await runWhitespaceStream(12);
				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toContain("whitespace-only tool-call argument delta");
			},
		);
	});

	it("lets the same stream through under the shipped cap", async () => {
		await withEnv(
			{ PI_CODEX_WHITESPACE_DELTA_EVENT_LIMIT: undefined, PI_CODEX_WHITESPACE_DELTA_CHAR_LIMIT: undefined },
			async () => {
				const result = await runWhitespaceStream(12);
				expect(result.stopReason).toBe("toolUse");
			},
		);
	});
});
