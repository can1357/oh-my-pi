import { describe, expect, it } from "bun:test";
import type { AssistantMessage, FetchImpl } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
	isContextOverflow,
	parseJsonWithRepair,
	parseStreamingJson,
	repairJson,
	streamSimpleOpenAIResponses,
} from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-ai-shim";

// Issue #6859: pi extensions import runtime helpers from the `@earendil-works/pi-ai`
// (aliased to `@oh-my-pi/pi-ai`) package root that omp's barrel no longer forwards.
// `isContextOverflow` moved under `@oh-my-pi/pi-ai/error` and the JSON-repair
// helpers moved to `@oh-my-pi/pi-utils`, so `export * from "@oh-my-pi/pi-ai"` left
// them off the shim surface and a named import tripped Bun's static
// "No matching export" check during plugin validation (e.g.
// `omp plugin install pi-blackhole`). This pins the bridged root surface so it
// cannot silently regress the way #6583 / #6648 did one symbol at a time.
function createErrorMessage(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

describe("legacy pi-ai shim root exports", () => {
	it("re-exports isContextOverflow with its classification behavior", () => {
		expect(typeof isContextOverflow).toBe("function");
		expect(isContextOverflow(createErrorMessage("prompt is too long: 300000 tokens > 200000 maximum"))).toBe(true);
		expect(isContextOverflow(createErrorMessage("400 Bad Request: invalid API key"))).toBe(false);
	});

	it("re-exports the JSON-repair helpers that upstream exposed at the pi-ai root", () => {
		// repairJson escapes a raw control char inside a string so JSON.parse stops throwing.
		const broken = `{"a": "b${String.fromCharCode(1)}c"}`;
		expect(() => JSON.parse(broken)).toThrow();
		expect(JSON.parse(repairJson(broken))).toEqual({ a: "b\u0001c" });
		// parseJsonWithRepair tolerates trailing commas / unquoted keys.
		expect(parseJsonWithRepair<{ a: number }>("{a: 1,}")).toEqual({ a: 1 });
		// parseStreamingJson completes a truncated object at the streaming edge.
		expect(parseStreamingJson<{ a: number }>('{"a": 1')).toEqual({ a: 1 });
	});
	it("maps legacy simple options before streaming OpenAI Responses", async () => {
		const requests: unknown[] = [];
		const fetchMock: FetchImpl = Object.assign(
			async () =>
				new Response(
					JSON.stringify({
						error: { message: "intentional test response", type: "invalid_request_error" },
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				),
			{ preconnect: fetch.preconnect },
		);
		const model = buildModel({
			id: "legacy-simple-options",
			name: "Legacy Simple Options",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://responses.example.test/v1",
			reasoning: true,
			compat: {
				supportsReasoningParams: true,
				supportsReasoningEffort: true,
			},
			thinking: {
				mode: "effort",
				efforts: [Effort.High],
			},
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});

		const result = await streamSimpleOpenAIResponses(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 0 }] },
			{
				apiKey: "test-key",
				reasoning: Effort.High,
				hideThinkingSummary: true,
				fetch: fetchMock,
				onPayload: request => {
					requests.push(request);
				},
			},
		).result();

		expect(result.stopReason).toBe("error");
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ reasoning: { effort: "high" } });
		expect(JSON.stringify(requests[0])).not.toContain('"summary"');
	});
});
