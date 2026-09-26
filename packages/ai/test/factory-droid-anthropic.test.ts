import { afterEach, describe, expect, it, mock } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { buildFactoryDroidModel, FACTORY_DROID_MODEL_META } from "@oh-my-pi/pi-catalog/discovery";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { streamFactoryDroid } from "../src/providers/factory-droid";
import type { Model } from "../src/types";
import {
	ANTHROPIC_EVENTS,
	anthropicChunks,
	type CapturedRequest,
	captureFetch,
	WORKOS_TOKEN,
} from "./helpers/factory-droid";

function opus46(): Model<"factory-droid-agent"> {
	return buildModel(
		buildFactoryDroidModel({
			id: "claude-opus-4-6",
			name: "Opus 4.6",
			wire: "anthropic-messages",
			contextWindow: 867_000,
			maxTokens: 128_000,
			apiProviders: ["anthropic", "vertex_anthropic", "bedrock_anthropic"],
			supportedReasoningEfforts: [Effort.Low, Effort.Medium, Effort.High, Effort.Max],
			defaultReasoningEffort: Effort.High,
			thinkingStyle: "adaptive",
			noImageSupport: true,
		}),
	);
}

function opus48(): Model<"factory-droid-agent"> {
	return buildModel(
		buildFactoryDroidModel({
			id: "claude-opus-4-8",
			name: "Opus 4.8",
			wire: "anthropic-messages",
			contextWindow: 867_000,
			maxTokens: 128_000,
			apiProviders: ["anthropic", "vertex_anthropic", "bedrock_anthropic"],
			supportedReasoningEfforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			defaultReasoningEffort: Effort.High,
			thinkingStyle: "adaptive-summarized",
			noImageSupport: true,
		}),
	);
}

afterEach(() => {
	mock.restore();
});

describe("Factory Droid anthropic wire (Claude)", () => {
	it("sends summarized adaptive thinking and the anthropic SDK fingerprint", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			opus48(),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: captureFetch(captured, anthropicChunks("OK"), ANTHROPIC_EVENTS),
				reasoning: Effort.High,
			},
		).result();

		const request = captured[0];
		// Summarized-adaptive models opt into readable thinking deltas; the
		// field order matches the CLI's own body.
		expect(request.body.thinking).toEqual({ type: "adaptive", display: "summarized" });
		// The Anthropic SDK renders its client's 600s timeout as a header; the
		// runtime version is droid's, not the host's.
		expect(request.headers["x-stainless-timeout"]).toBe("600");
		expect(request.headers["x-stainless-runtime-version"]).toBe("v24.3.0");
		expect(request.headers["x-stainless-package-version"]).toBe("0.70.1");
		expect(request.headers["x-stainless-helper-method"]).toBeUndefined();
		expect(request.headers["x-provider-routing-source"]).toBe("configured_order");
		expect(request.headers["x-api-key"]).toBe("placeholder");
	});

	it("omits the adaptive display field on models that reject it", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			opus46(),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: captureFetch(captured, anthropicChunks("OK"), ANTHROPIC_EVENTS),
				reasoning: Effort.High,
			},
		).result();

		// Opus 4.6 predates `thinking.display` and 400s on it.
		expect(captured[0].body.thinking).toEqual({ type: "adaptive" });
	});

	it("keeps MiniMax M2.7 on Anthropic budget-effort with Core-backed Fireworks routing", async () => {
		const captured: CapturedRequest[] = [];
		const model = buildModel(buildFactoryDroidModel(FACTORY_DROID_MODEL_META["minimax-m2.7"]!));
		await streamFactoryDroid(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: captureFetch(captured, anthropicChunks("OK"), ANTHROPIC_EVENTS),
				reasoning: Effort.High,
			},
		).result();

		const request = captured[0];
		expect(request.url).toStartWith("https://api.factory.ai/api/llm/a/v1/messages");
		expect(request.headers["x-api-provider"]).toBe("fireworks");
		expect(request.body.thinking).toMatchObject({ type: "enabled", budget_tokens: 24_576 });
		expect(request.body.output_config).toEqual({ effort: "high" });
		expect(request.headers["anthropic-beta"] ?? "").not.toContain("effort-2025-11-24");
	});

	it("passes the full effort ladder through on adaptive models (max stays max)", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			opus46(),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: captureFetch(captured, anthropicChunks("OK"), ANTHROPIC_EVENTS),
				reasoning: Effort.Max,
			},
		).result();

		const request = captured[0];
		expect(request.body.thinking).toEqual({ type: "adaptive" });
		expect(request.body.output_config).toEqual({ effort: "max" });
	});

	it("keeps Opus 5.5 adaptive max and caller tools on the Anthropic wire", async () => {
		const captured: CapturedRequest[] = [];
		const model = buildModel(buildFactoryDroidModel(FACTORY_DROID_MODEL_META["claude-opus-5-5"]!));
		await streamFactoryDroid(
			model,
			{
				systemPrompt: ["Caller policy"],
				messages: [{ role: "user", content: "hello", timestamp: 1 }],
				tools: [{ name: "Read", description: "Read file", parameters: type({ path: "string" }) }],
			},
			{
				apiKey: WORKOS_TOKEN,
				fetch: captureFetch(captured, anthropicChunks("OK"), ANTHROPIC_EVENTS),
				reasoning: Effort.Max,
			},
		).result();

		const request = captured[0];
		expect(request.body.thinking).toMatchObject({ type: "adaptive" });
		expect(request.body.output_config).toEqual({ effort: "max" });
		expect(request.body.tools).toBeDefined();
		expect(JSON.stringify(request.body.system)).toContain("Caller policy");
	});

	it("sends Opus 5.5 Fast Mode speed and beta without changing tools or thinking", async () => {
		const captured: CapturedRequest[] = [];
		const model = buildModel(buildFactoryDroidModel(FACTORY_DROID_MODEL_META["claude-opus-5-5-fast"]!));
		await streamFactoryDroid(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: captureFetch(captured, anthropicChunks("OK"), ANTHROPIC_EVENTS),
				reasoning: Effort.Max,
			},
		).result();

		expect(captured[0].body.speed).toBe("fast");
		expect(captured[0].headers["anthropic-beta"]).toContain("fast-mode-2026-02-01");
		expect(captured[0].body.thinking).toMatchObject({ type: "adaptive" });
		expect(captured[0].body.output_config).toEqual({ effort: "max" });
	});

	it("appends the effort beta on Bedrock/Vertex upstreams when effort is on the wire", async () => {
		const routed = opus48();
		routed.factoryDroidApiProviders = ["bedrock_anthropic"];
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			routed,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: captureFetch(captured, anthropicChunks("OK"), ANTHROPIC_EVENTS),
				reasoning: Effort.High,
			},
		).result();

		const request = captured[0];
		expect(request.headers["x-api-provider"]).toBe("bedrock_anthropic");
		expect(request.body.output_config).toEqual({ effort: "high" });
		expect(request.headers["anthropic-beta"]).toContain("effort-2025-11-24");
	});

	it("sends the refusal fallback chain and both betas for fable models on the direct anthropic upstream", async () => {
		const captured: CapturedRequest[] = [];
		const model = buildModel(buildFactoryDroidModel(FACTORY_DROID_MODEL_META["claude-fable-5"]!));
		const result = await streamFactoryDroid(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: captureFetch(captured, anthropicChunks("OK"), ANTHROPIC_EVENTS),
				reasoning: Effort.High,
			},
		).result();

		expect(result.stopReason).toBe("stop");
		const request = captured[0]!;
		expect(request.headers["x-api-provider"]).toBe("anthropic");
		expect(request.body.fallbacks).toEqual([{ model: "claude-opus-5" }]);
		expect(request.headers["anthropic-beta"]).toContain("server-side-fallback-2026-06-01");
		expect(request.headers["anthropic-beta"]).toContain("fallback-credit-2026-06-01");
	});

	it("withholds refusal fallbacks on vertex/bedrock rotations, which gate the beta themselves", async () => {
		const captured: CapturedRequest[] = [];
		const model = buildModel(buildFactoryDroidModel(FACTORY_DROID_MODEL_META["claude-fable-5"]!));
		model.factoryDroidApiProviders = ["vertex_anthropic"];
		await streamFactoryDroid(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: captureFetch(captured, anthropicChunks("OK"), ANTHROPIC_EVENTS),
				reasoning: Effort.High,
			},
		).result();

		const request = captured[0]!;
		expect(request.headers["x-api-provider"]).toBe("vertex_anthropic");
		expect(request.body.fallbacks).toBeUndefined();
		expect(request.headers["anthropic-beta"] ?? "").not.toContain("server-side-fallback-2026-06-01");
		expect(request.headers["anthropic-beta"] ?? "").not.toContain("fallback-credit-2026-06-01");
	});
});
