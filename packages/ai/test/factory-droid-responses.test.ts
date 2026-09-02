import { afterEach, describe, expect, it, mock } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { buildFactoryDroidModel } from "@oh-my-pi/pi-catalog/discovery";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { DROID_SYSTEM_PREFIX, streamFactoryDroid } from "../src/providers/factory-droid";
import type { Model, Tool } from "../src/types";
import { type CapturedRequest, captureFetch, responsesChunks, workosJwt } from "./helpers/factory-droid";

/**
 * Responses-wire parity with the droid CLI: per-model-class request bodies and
 * headers (text.verbosity, safety_identifier, tool_choice, max_output_tokens
 * gating, reasoning.summary, prompt_cache_retention, OpenAI-Platform).
 */

function gpt52(): Model<"factory-droid-agent"> {
	return buildModel(
		buildFactoryDroidModel({
			id: "gpt-5.2",
			name: "GPT-5.2",
			wire: "openai-responses",
			contextWindow: 272_000,
			maxTokens: 128_000,
			apiProviders: ["openai"],
			supportedReasoningEfforts: ["off", Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			defaultReasoningEffort: Effort.Low,
			// Native apiRequest for gpt-5.2 is { verbosity: "low" } only: no
			// extendedCache, no safetyId.
			responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: false, safetyId: false },
		}),
	);
}

function gpt52Codex(): Model<"factory-droid-agent"> {
	return buildModel(
		buildFactoryDroidModel({
			id: "gpt-5.2-codex",
			name: "GPT-5.2-Codex",
			wire: "openai-responses",
			contextWindow: 272_000,
			maxTokens: 128_000,
			apiProviders: ["openai"],
			supportedReasoningEfforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			defaultReasoningEffort: Effort.Medium,
			responsesConfig: { parallelToolCalls: true, extendedCache: true, safetyId: true },
		}),
	);
}

function gpt54(rotation?: string[]): Model<"factory-droid-agent"> {
	return buildModel(
		buildFactoryDroidModel(
			{
				id: "gpt-5.4",
				name: "GPT-5.4",
				wire: "openai-responses",
				contextWindow: 400_000,
				maxTokens: 128_000,
				apiProviders: ["openai", "bedrock_openai"],
				supportedReasoningEfforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				defaultReasoningEffort: Effort.Medium,
				responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: true, safetyId: true },
			},
			rotation,
		),
	);
}

function grok45(): Model<"factory-droid-agent"> {
	return buildModel(
		buildFactoryDroidModel({
			id: "grok-4.5",
			name: "Grok 4.5",
			wire: "openai-responses",
			contextWindow: 200_000,
			maxTokens: 63_356,
			apiProviders: ["xai"],
			supportedReasoningEfforts: [Effort.Low, Effort.Medium, Effort.High],
			defaultReasoningEffort: Effort.High,
		}),
	);
}

const readTool: Tool = {
	name: "Read",
	description: "Read a file",
	parameters: type({ path: "string" }),
};

/** Credential carrying the WorkOS user id (`sub`) and org claims. */
const WORKOS_TOKEN_WITH_USER = workosJwt({ sub: "user_123", external_org_id: "org-1" });
/** Credential with only the org claim, as WorkOS tokens without a sub would be. */
const WORKOS_TOKEN_NO_SUB = workosJwt({ external_org_id: "org-1" });

function context() {
	return {
		systemPrompt: ["OMP prompt"],
		messages: [{ role: "user" as const, content: "hello", timestamp: 1 }],
		tools: [readTool],
	};
}

afterEach(() => {
	mock.restore();
});

describe("Factory Droid responses wire (parity fixes)", () => {
	it("gpt-5.2 sends verbosity-only shaping: text.verbosity low, no retention, no safety id, no tool_choice", async () => {
		const captured: CapturedRequest[] = [];
		const result = await streamFactoryDroid(gpt52(), context(), {
			apiKey: WORKOS_TOKEN_WITH_USER,
			fetch: captureFetch(captured, responsesChunks("GPT_OK")),
			sessionId: "sess-1",
			reasoning: Effort.Medium,
		}).result();

		expect(result.stopReason).toBe("stop");
		const request = captured[0];
		expect(request.url).toBe("https://api.factory.ai/api/llm/o/v1/responses");
		expect(request.headers["x-api-provider"]).toBe("openai");
		// Factory's hardcoded OpenAI org rides GPT responses requests.
		expect(request.headers["openai-platform"]).toBe("org-bHuLtG1fGmYk5YaOihAAXFBw");
		expect(request.body.model).toBe("gpt-5.2");
		// The CLI always keys the prompt cache with the session id...
		expect(request.body.prompt_cache_key).toBeDefined();
		// ...but reserves the "24h" retention for extendedCache models only.
		expect(request.body.prompt_cache_retention).toBeUndefined();
		// Verbosity rides under `text` on the HTTPS Responses route.
		expect(request.body.text).toEqual({ verbosity: "low" });
		expect(request.body.safety_identifier).toBeUndefined();
		// tool_choice is caller-only; no openai-family auto default (the API's
		// default is already auto, probe-verified the omission is accepted).
		expect(request.body.tool_choice).toBeUndefined();
		expect(request.body.max_output_tokens).toBeUndefined();
		expect(request.body.temperature).toBeUndefined();
		expect(request.body.reasoning).toEqual({ effort: "medium", summary: "auto" });
	});

	it("codex extendedCache+safetyId sends retention and the session id as safety_identifier (native parity)", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(gpt52Codex(), context(), {
			apiKey: WORKOS_TOKEN_WITH_USER,
			fetch: captureFetch(captured, responsesChunks("GPT_OK")),
			sessionId: "sess-1",
			reasoning: Effort.High,
		}).result();

		const request = captured[0];
		expect(request.body.prompt_cache_retention).toBe("24h");
		// Native computes userId ?? sessionId but never passes userId — the wire value is the session id,
		// deterministically mapped to a v4-shaped uuid (shape pinned; exact bytes are algorithm-internal).
		expect(request.body.safety_identifier).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(request.body.safety_identifier).toBe(request.body.prompt_cache_key);
		// No verbosity on gpt-5.2-codex's native apiRequest.
		expect(request.body.text).toBeUndefined();
		// Parallel tool calls ride the API default (on); only false is written.
		expect(request.body.parallel_tool_calls).toBeUndefined();
		expect(request.body.tool_choice).toBeUndefined();
		expect(request.body.max_output_tokens).toBeUndefined();
		expect(request.body.reasoning).toEqual({ effort: "high", summary: "auto" });
	});

	it("safety_identifier falls back to the session uuid when the token has no user id claim", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(gpt52Codex(), context(), {
			apiKey: WORKOS_TOKEN_NO_SUB,
			fetch: captureFetch(captured, responsesChunks("GPT_OK")),
			sessionId: "sess-1",
			reasoning: Effort.High,
		}).result();

		const request = captured[0];
		// Never the org claim: the CLI sends userId ?? sessionId.
		expect(request.body.safety_identifier).not.toBe("org-1");
		// Deterministic v4-shaped mapping of the session id — identical to the cache key.
		expect(request.body.safety_identifier).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(request.body.safety_identifier).toBe(request.body.prompt_cache_key);
	});

	it("grok keeps max_output_tokens and drops summary, verbosity, retention, tool_choice, and OpenAI-Platform", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(grok45(), context(), {
			apiKey: WORKOS_TOKEN_WITH_USER,
			fetch: captureFetch(captured, responsesChunks("GPT_OK")),
			sessionId: "sess-1",
			reasoning: Effort.High,
		}).result();

		const request = captured[0];
		expect(request.headers["x-api-provider"]).toBe("xai");
		expect(request.headers["openai-platform"]).toBeUndefined();
		expect(request.body.model).toBe("grok-4.5");
		// xai is the only responses family that carries an output cap.
		expect(request.body.max_output_tokens).toBe(63_356);
		// The CLI omits reasoning.summary for xai-routed models.
		expect(request.body.reasoning).toEqual({ effort: "high" });
		expect(request.body.text).toBeUndefined();
		expect(request.body.prompt_cache_retention).toBeUndefined();
		expect(request.body.tool_choice).toBeUndefined();
		expect(request.body.safety_identifier).toBeUndefined();
		expect(request.body.temperature).toBeUndefined();
	});

	it("bedrock_openai rotation drops retention and OpenAI-Platform but keeps openai-family shaping", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(gpt54(["bedrock_openai"]), context(), {
			apiKey: WORKOS_TOKEN_NO_SUB,
			fetch: captureFetch(captured, responsesChunks("GPT_OK")),
			sessionId: "sess-1",
			reasoning: Effort.High,
		}).result();

		const request = captured[0];
		expect(request.headers["x-api-provider"]).toBe("bedrock_openai");
		expect(request.headers["openai-platform"]).toBeUndefined();
		// Retention requires the resolved upstream to be openai; rotations drop it.
		expect(request.body.prompt_cache_retention).toBeUndefined();
		// The cache key itself still rides every model.
		expect(request.body.prompt_cache_key).toBeDefined();
		// Registry-provider shaping survives the rotation (max tokens stays openai-shaped).
		expect(request.body.tool_choice).toBeUndefined();
		expect(request.body.max_output_tokens).toBeUndefined();
		expect(request.body.reasoning).toEqual({ effort: "high", summary: "auto" });
		expect(request.body.text).toEqual({ verbosity: "low" });
	});

	it("caller textVerbosity wins over the registry verbosity", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(gpt52(), context(), {
			apiKey: WORKOS_TOKEN_WITH_USER,
			fetch: captureFetch(captured, responsesChunks("GPT_OK")),
			sessionId: "sess-1",
			reasoning: Effort.Medium,
			textVerbosity: "medium",
		}).result();

		expect(captured[0].body.text).toEqual({ verbosity: "medium" });
	});

	it("an explicit caller toolChoice is forwarded as-is", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(gpt52(), context(), {
			apiKey: WORKOS_TOKEN_WITH_USER,
			fetch: captureFetch(captured, responsesChunks("GPT_OK")),
			sessionId: "sess-1",
			reasoning: Effort.Medium,
			toolChoice: "none",
		}).result();

		expect(captured[0].body.tool_choice).toBe("none");
	});

	it("never forwards caller temperature on this wire", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(gpt52(), context(), {
			apiKey: WORKOS_TOKEN_WITH_USER,
			fetch: captureFetch(captured, responsesChunks("GPT_OK")),
			sessionId: "sess-1",
			reasoning: Effort.Medium,
			temperature: 0.3,
		}).result();

		expect(captured[0].body.temperature).toBeUndefined();
		expect(JSON.stringify(captured[0].body)).not.toContain('"temperature"');
		expect(JSON.stringify(captured[0].body.instructions)).toContain(DROID_SYSTEM_PREFIX);
	});

	it("surfaces a non-200 JSON error body as a provider error on the responses wire", async () => {
		const result = await streamFactoryDroid(gpt52(), context(), {
			apiKey: WORKOS_TOKEN_WITH_USER,
			fetch: mock(
				async () =>
					new Response(JSON.stringify({ error: { message: "model not available" } }), {
						status: 400,
						headers: { "Content-Type": "application/json" },
					}),
			),
			sessionId: "sess-1",
			reasoning: Effort.Medium,
		}).result();

		// The transport decodes the OpenAI-style envelope and surfaces the status
		// plus detail; a rejection must not look like a clean stop.
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(result.errorMessage).toContain("400");
		expect(result.errorMessage).toContain("model not available");
	});
});
