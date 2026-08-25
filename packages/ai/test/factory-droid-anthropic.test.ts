import { afterEach, describe, expect, it, mock } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { buildFactoryDroidModel } from "@oh-my-pi/pi-catalog/discovery";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { streamFactoryDroid } from "../src/providers/factory-droid";
import type { AssistantMessage, Model } from "../src/types";
import {
	ANTHROPIC_EVENTS,
	anthropicChunks,
	type CapturedRequest,
	captureFetch,
	WORKOS_TOKEN,
} from "./helpers/factory-droid";

function opus46Fast(): Model<"factory-droid-agent"> {
	return buildModel(
		buildFactoryDroidModel({
			id: "claude-opus-4-6-fast",
			name: "Opus 4.6 Fast Mode",
			wire: "anthropic-messages",
			contextWindow: 867_000,
			maxTokens: 128_000,
			apiProviders: ["anthropic"],
			supportedReasoningEfforts: [Effort.Low, Effort.Medium, Effort.High, Effort.Max],
			defaultReasoningEffort: Effort.High,
			thinkingStyle: "adaptive",
			noImageSupport: true,
		}),
	);
}

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

function minimaxM3(): Model<"factory-droid-agent"> {
	return buildModel(
		buildFactoryDroidModel({
			id: "minimax-m3",
			name: "MiniMax M3 (Droid Core)",
			wire: "anthropic-messages",
			contextWindow: 200_000,
			maxTokens: 64_000,
			apiProviders: ["fireworks"],
			supportedReasoningEfforts: [Effort.High],
			defaultReasoningEffort: Effort.High,
			thinkingStyle: "budget-effort",
		}),
	);
}

/** A persisted MiniMax assistant turn, shaped like the messages the harness stores. */
function minimaxAssistant(
	blocks: Array<{ type: "text"; text: string } | { type: "thinking"; thinking: string }>,
	timestamp: number,
): AssistantMessage {
	return {
		role: "assistant",
		content: blocks,
		api: "factory-droid-agent",
		provider: "factory-droid",
		model: "minimax-m3",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

afterEach(() => {
	mock.restore();
});

describe("Factory Droid anthropic wire (Claude + MiniMax)", () => {
	it("sends speed fast plus the fast-mode beta for fast variants", async () => {
		const captured: CapturedRequest[] = [];
		const result = await streamFactoryDroid(
			opus46Fast(),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: captureFetch(captured, anthropicChunks("FAST_OK"), ANTHROPIC_EVENTS),
				reasoning: Effort.High,
			},
		).result();

		expect(result.stopReason).toBe("stop");
		const request = captured[0];
		expect(request.url).toStartWith("https://api.factory.ai/api/llm/a/v1/messages");
		expect(request.headers["x-api-provider"]).toBe("anthropic");
		// The CLI sends top-level `speed: "fast"` plus the fast-mode beta.
		expect(request.body.speed).toBe("fast");
		expect(request.headers["anthropic-beta"]).toContain("fast-mode-2026-02-01");
		expect(request.body.thinking).toEqual({ type: "adaptive" });
		expect(request.body.output_config).toEqual({ effort: "high" });
		// Fast variants are direct-anthropic only: no effort beta on the wire.
		expect(request.headers["anthropic-beta"]).not.toContain("effort-2025-11-24");
	});

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

	it("defaults adaptive effort to high when no reasoning is specified", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			opus46Fast(),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: captureFetch(captured, anthropicChunks("OK"), ANTHROPIC_EVENTS),
			},
		).result();

		const request = captured[0];
		// Global native default for adaptive models is high ("output_config.effort").
		expect(request.body.thinking).toEqual({ type: "adaptive" });
		expect(request.body.output_config).toEqual({ effort: "high" });
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

	it("coerces xhigh to high on budget-effort MiniMax and omits the effort beta", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			minimaxM3(),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: captureFetch(captured, anthropicChunks("OK"), ANTHROPIC_EVENTS),
				reasoning: Effort.XHigh,
			},
		).result();

		const request = captured[0];
		// Budget-effort maps through {low,medium,high} only: xhigh falls back to
		// high on the wire while the budget keeps xhigh's ladder token budget.
		expect(request.body.output_config).toEqual({ effort: "high" });
		expect(request.body.thinking).toMatchObject({ type: "enabled", budget_tokens: 32_768 });
		expect(request.body.speed).toBeUndefined();
		// MiniMax never advertises the effort beta (native IfR betaFlags: []).
		expect(request.headers["anthropic-beta"] ?? "").not.toContain("effort-2025-11-24");
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

	it("keeps thinking config and replayed thinking when a non-adaptive conversation is thinking-led", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			minimaxM3(),
			{
				messages: [
					{ role: "user", content: "hi", timestamp: 1 },
					minimaxAssistant(
						[
							{ type: "thinking", thinking: "prior reasoning" },
							{ type: "text", text: "sure" },
						],
						2,
					),
					{ role: "user", content: "go on", timestamp: 3 },
				],
			},
			{
				apiKey: WORKOS_TOKEN,
				fetch: captureFetch(captured, anthropicChunks("OK"), ANTHROPIC_EVENTS),
				reasoning: Effort.High,
			},
		).result();

		const request = captured[0];
		// The last assistant turn leads with thinking, so the CLI resumes the
		// thinking chain: config and replayed blocks stay.
		expect(request.body.thinking).toMatchObject({ type: "enabled" });
		expect(request.body.output_config).toEqual({ effort: "high" });
		expect(JSON.stringify(request.body.messages)).toContain("prior reasoning");
	});

	it("strips thinking config and replayed thinking when a non-adaptive conversation is not thinking-led", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			minimaxM3(),
			{
				messages: [
					{ role: "user", content: "hi", timestamp: 1 },
					minimaxAssistant(
						[
							{ type: "text", text: "sure" },
							{ type: "thinking", thinking: "prior reasoning" },
						],
						2,
					),
					{ role: "user", content: "go on", timestamp: 3 },
				],
			},
			{
				apiKey: WORKOS_TOKEN,
				fetch: captureFetch(captured, anthropicChunks("OK"), ANTHROPIC_EVENTS),
				reasoning: Effort.High,
			},
		).result();

		const request = captured[0];
		// No assistant turn opens with thinking: the CLI drops the `thinking`
		// field (budget-effort keeps output_config) and replays history without
		// the prior thinking block.
		expect(request.body.thinking).toBeUndefined();
		expect(request.body.output_config).toEqual({ effort: "high" });
		expect(JSON.stringify(request.body.messages)).not.toContain("prior reasoning");
		const assistant = (request.body.messages as Array<Record<string, unknown>>).find(
			message => message.role === "assistant",
		);
		const blocks = assistant?.content as Array<{ type?: string }>;
		expect(blocks.map(block => block.type)).toEqual(["text"]);
	});
});
