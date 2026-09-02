import { describe, expect, it } from "bun:test";
import { convertMessages } from "@oh-my-pi/pi-ai/providers/google-shared";
import type { Context, Model, ToolCall, Usage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// Regression for #9638. A Gemini 3 turn with parallel tool calls carries a thought
// signature only on the FIRST call. `convertMessages` used to substitute the
// `skip_thought_signature_validator` sentinel for every unsigned Gemini 3 tool call.
// That sentinel is honored ONLY by the public Gemini API (`google-generative-ai`);
// Cloud Code Assist / Antigravity and Vertex AI reject it with 400 INVALID_ARGUMENT.
// Since the offending turn is baked into session history, every subsequent request
// replayed it and 400'd deterministically, permanently wedging the session.
//
// The contract now splits by transport:
//   - public Gemini API: keep the sentinel for unsigned calls (it needs a signature
//     on every call and accepts the bypass — no regression for cross-model replay,
//     secret-redacted args, or parallel calls).
//   - CCA/Antigravity + Vertex: omit `thoughtSignature` on unsigned calls (those
//     backends reject the sentinel; Gemini 3 there only requires it on the first call).

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const VALID_SIGNATURE = "QUJDRA==";
const SENTINEL = "skip_thought_signature_validator";

type GoogleApi = "google-generative-ai" | "google-gemini-cli" | "google-vertex";

function buildGeminiModel(api: GoogleApi, provider: string, id: string): Model<GoogleApi> {
	return buildModel({
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65536,
	});
}

function assistantTurn(api: GoogleApi, provider: string, id: string, content: ToolCall[]): Context {
	return {
		messages: [
			{ role: "user", content: "Optimize the code", timestamp: 1000 },
			{
				role: "assistant",
				provider,
				api,
				model: id,
				content,
				usage: ZERO_USAGE,
				stopReason: "toolUse",
				timestamp: 2000,
			},
		],
	};
}

/** One assistant turn with three parallel tool calls; only the first is signed. */
function parallelToolCalls(api: GoogleApi, provider: string, id: string): Context {
	return assistantTurn(api, provider, id, [
		{ type: "toolCall", id: "call_1", name: "todo", arguments: { op: "init" }, thoughtSignature: VALID_SIGNATURE },
		{ type: "toolCall", id: "call_2", name: "grep", arguments: { pattern: "helperExec" } },
		{ type: "toolCall", id: "call_3", name: "grep", arguments: { pattern: "shift" } },
	]);
}

/** One assistant turn whose sole tool call has no signature (cross-model replay / redacted args). */
function unsignedFirstCall(api: GoogleApi, provider: string, id: string): Context {
	return assistantTurn(api, provider, id, [
		{ type: "toolCall", id: "call_1", name: "grep", arguments: { pattern: "shift" } },
	]);
}

function toolCallParts(model: Model<GoogleApi>, context: Context) {
	const contents = convertMessages(model, context);
	return contents.find(c => c.role === "model")?.parts?.filter(part => part.functionCall) ?? [];
}

describe("Gemini 3 unsigned tool-call signatures (#9638)", () => {
	it("omits unsigned signatures and never emits the sentinel on Antigravity/CCA", () => {
		const model = buildGeminiModel("google-gemini-cli", "google-antigravity", "gemini-3.7-flash");

		const parallel = parallelToolCalls("google-gemini-cli", "google-antigravity", "gemini-3.7-flash");
		const parallelCalls = toolCallParts(model, parallel);
		expect(parallelCalls).toHaveLength(3);
		expect(parallelCalls[0]?.thoughtSignature).toBe(VALID_SIGNATURE);
		expect(parallelCalls[1]?.thoughtSignature).toBeUndefined();
		expect(parallelCalls[2]?.thoughtSignature).toBeUndefined();
		// The sentinel is what CCA rejects with 400 INVALID_ARGUMENT — it must never reach the wire.
		expect(JSON.stringify(convertMessages(model, parallel))).not.toContain(SENTINEL);

		const unsigned = unsignedFirstCall("google-gemini-cli", "google-antigravity", "gemini-3.7-flash");
		const unsignedCalls = toolCallParts(model, unsigned);
		expect(unsignedCalls[0]?.thoughtSignature).toBeUndefined();
		expect(JSON.stringify(convertMessages(model, unsigned))).not.toContain(SENTINEL);
	});

	it("omits unsigned signatures and never emits the sentinel on Vertex", () => {
		const model = buildGeminiModel("google-vertex", "google-vertex", "gemini-3-flash");
		const unsigned = unsignedFirstCall("google-vertex", "google-vertex", "gemini-3-flash");
		const calls = toolCallParts(model, unsigned);

		expect(calls[0]?.thoughtSignature).toBeUndefined();
		expect(JSON.stringify(convertMessages(model, unsigned))).not.toContain(SENTINEL);
	});

	it("keeps the sentinel bypass for unsigned calls on the public Gemini API", () => {
		const model = buildGeminiModel("google-generative-ai", "google", "gemini-3-flash");

		// An unsigned first call (cross-model replay / redacted args) must carry the
		// sentinel — the public endpoint 400s on a missing signature.
		const unsigned = unsignedFirstCall("google-generative-ai", "google", "gemini-3-flash");
		expect(toolCallParts(model, unsigned)[0]?.thoughtSignature).toBe(SENTINEL);

		// Parallel: the real signature is kept, the unsigned siblings get the sentinel.
		const parallelCalls = toolCallParts(model, parallelToolCalls("google-generative-ai", "google", "gemini-3-flash"));
		expect(parallelCalls[0]?.thoughtSignature).toBe(VALID_SIGNATURE);
		expect(parallelCalls[1]?.thoughtSignature).toBe(SENTINEL);
		expect(parallelCalls[2]?.thoughtSignature).toBe(SENTINEL);
	});
});
