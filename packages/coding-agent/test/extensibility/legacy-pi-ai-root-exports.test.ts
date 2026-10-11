import { describe, expect, it } from "bun:test";
import type { AssistantMessage, FetchImpl } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
	anthropicMessagesApi,
	collapseSystemMessages,
	createInitialSystemMessage,
	declarationsEqual,
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
	getDeclaredTools,
	getInitialSystemMessage,
	getToolStateChanges,
	hasNonAdditiveToolChanges,
	hasToolRedefinitions,
	isContextOverflow,
	normalizeContext,
	parseJsonWithRepair,
	parseStreamingJson,
	repairJson,
	resolveTranscript,
	resolveTranscriptTools,
	streamSimpleOpenAIResponses,
	toToolDeclaration,
	withoutInitialSystemMessage,
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

	it("exposes the host Anthropic transport through the legacy compat adapter", async () => {
		const urls: string[] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (input: string | URL | Request) => {
				urls.push(input instanceof Request ? input.url : input.toString());
				return new Response(
					JSON.stringify({
						type: "error",
						error: { type: "invalid_request_error", message: "intentional test response" },
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				);
			},
			{ preconnect: fetch.preconnect },
		);
		const model = buildModel({
			id: "legacy-anthropic-adapter",
			name: "Legacy Anthropic Adapter",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://anthropic.example.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		});

		const result = await anthropicMessagesApi()
			.streamSimple(
				model,
				{ messages: [{ role: "user", content: "hello", timestamp: 0 }] },
				{
					apiKey: "test-key",
					fetch: fetchMock,
				},
			)
			.result();

		expect(result.stopReason).toBe("error");
		expect(urls).toEqual(["https://anthropic.example.test/v1/messages"]);
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

// Upstream pi-ai 1.x exposes the transcript-replay module from its package
// root (present since at least 1.0.2). omp forked before it existed and has
// no equivalent, so `export *` could not satisfy named imports of e.g.
// `getCurrentSystemMessage` (observed consumer: `pi-optchat`, which replays
// tool state when rebuilding the system prompt of its bounded memory view).
// These pin the ported surface's behavior, not just its presence: replay,
// section patching, tool-state deltas, and addition anchoring must match
// upstream exactly.
describe("legacy pi-ai shim transcript replay exports", () => {
	it("normalizeContext folds systemPrompt and tools into a leading system message", () => {
		const tool = { name: "read", description: "Read a file", parameters: { type: "object" } };
		expect(normalizeContext({ systemPrompt: undefined, tools: undefined, messages: [] })).toEqual({ messages: [] });
		const context = normalizeContext({
			systemPrompt: "Be terse.",
			tools: [tool],
			messages: [{ role: "user", content: "hi" }],
		});
		expect(context.messages).toHaveLength(2);
		expect(context.messages[0]).toMatchObject({ role: "system", content: "Be terse.", timestamp: 0 });
		expect(createInitialSystemMessage(undefined, undefined)).toBeUndefined();
	});

	it("getCurrentSystemMessage replays content, patches sections, and resolves tool state", () => {
		const read = { name: "read", description: "v1", parameters: {} };
		const glob = { name: "glob", description: "Find files", parameters: {} };
		const messages = [
			{ role: "system", content: "Base prompt.", toolsAdded: [read, glob], timestamp: 10 },
			{ role: "user", content: "hi", timestamp: 11 },
			{ role: "system", content: "Extra rule.", sections: { style: "terse", stale: "old" }, timestamp: 12 },
			{
				role: "system",
				content: "Patch.",
				sections: { style: "short", stale: null },
				toolsRemoved: [{ name: "glob" }],
				timestamp: 13,
			},
		];
		const replayed = getCurrentSystemMessage(messages);
		expect(replayed).toBeDefined();
		// Content appended with blank-line separation; timestamp from the FIRST system message.
		expect(replayed?.content).toBe("Base prompt.\n\nExtra rule.\n\nPatch.");
		expect(replayed?.timestamp).toBe(10);
		// `stale` was set then patched with null, which deletes it from the replay.
		expect(replayed?.sections).toEqual({ style: "short" });
		const currentTools = getCurrentTools(messages);
		expect(currentTools.map(t => t.name)).toEqual(["read"]);
		expect(getCurrentSystemPrompt(messages)).toBe("Base prompt.\n\nExtra rule.\n\nPatch.\n\nshort");
	});

	it("declaration equality drives tool-state change detection", () => {
		const readV1 = { name: "read", description: "v1", parameters: { type: "object", additionalProperties: true } };
		const readV2 = { name: "read", description: "v2", parameters: { type: "object", additionalProperties: true } };
		expect(declarationsEqual(readV1, { ...readV1 })).toBe(true);
		expect(getToolStateChanges([readV1], [readV2])).toEqual({
			toolsAdded: [toToolDeclaration(readV2)],
			toolsRemoved: [{ name: "read" }],
		});
		expect(getDeclaredTools([{ role: "system", toolsAdded: [readV1, readV2] }])).toHaveLength(1);
		// Same name declared twice with DIFFERENT definitions is a redefinition; identical re-declarations are not.
		expect(hasToolRedefinitions([{ role: "system", toolsAdded: [readV1, readV2] }])).toBe(true);
		expect(hasToolRedefinitions([{ role: "system", toolsAdded: [readV1, { ...readV1 }] }])).toBe(false);
		expect(
			hasNonAdditiveToolChanges([{ role: "system", toolsAdded: [readV1], toolsRemoved: [{ name: "glob" }] }]),
		).toBe(true);
	});

	it("resolveTranscriptTools anchors additions only when history is purely additive", () => {
		const read = { name: "read", description: "r", parameters: {} };
		const glob = { name: "glob", description: "g", parameters: {} };
		const additive = [{ role: "system", content: "", toolsAdded: [read], timestamp: 0 }];
		expect(resolveTranscriptTools(additive, true)).toEqual({ requestTools: [read], anchorsAdditions: true });
		const nonAdditive = [
			{ role: "system", content: "", toolsAdded: [read, glob], timestamp: 0 },
			{ role: "system", content: "", toolsRemoved: [{ name: "glob" }], timestamp: 1 },
		];
		expect(resolveTranscriptTools(nonAdditive, true)).toEqual({ requestTools: [read], anchorsAdditions: false });
	});

	it("collapseSystemMessages and resolveTranscript gate mid-conversation system support", () => {
		const leading = { role: "system", content: "lead", timestamp: 0 };
		const later = { role: "system", content: "later", timestamp: 1 };
		const user = { role: "user", content: "hi", timestamp: 2 };
		const collapsed = collapseSystemMessages({ messages: [leading, user, later] });
		expect(collapsed.messages).toHaveLength(2);
		expect(collapsed.messages[0]?.content).toBe("lead\n\nlater");
		expect(resolveTranscript({ messages: [leading, user, later] }, true)).toEqual({
			messages: [leading, user, later],
		});
		expect(withoutInitialSystemMessage([leading, user])).toEqual([user]);
		expect(getInitialSystemMessage([user, leading])).toBeUndefined();
	});
});
