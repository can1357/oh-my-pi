import { describe, expect, it } from "bun:test";
import { resolveModelPolicy } from "../src/compat/resolve";
import type { ModelSpec } from "../src/types";

function spec(overrides: Partial<ModelSpec<"anthropic-messages">> = {}): ModelSpec<"anthropic-messages"> {
	return {
		api: "anthropic-messages",
		id: "anthropic--claude-4.6-opus",
		name: "Claude 4.6 Opus via proxy",
		provider: "my-proxy",
		baseUrl: "http://localhost:6655/anthropic",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8192,
		contextWindow: 200000,
		reasoning: true,
		...overrides,
	} as ModelSpec<"anthropic-messages">;
}

describe("#4297 anthropic-messages replay-unsigned-thinking classification", () => {
	it("keeps native replay on opaque custom reasoning endpoints (no name detection)", () => {
		// The reporter's custom Claude proxy is indistinguishable from a
		// non-signing third-party reasoning endpoint at config time — the
		// default must not walk back #2005's native replay for the 3p
		// majority.
		expect(resolveModelPolicy(spec()).compat.replayUnsignedThinking).toBe(true);
	});

	it("keeps native replay on a Cloudflare-internal Claude gateway that is not the AI Gateway route", () => {
		// `opencode.cloudflare.dev/anthropic` (issue #4297 comment) is a
		// private Cloudflare Workers deployment, not `gateway.ai.cloudflare.com`.
		// Opaque custom signing proxy — user marks it with the compat override
		// and the transport surfaces the actionable error before then.
		expect(
			resolveModelPolicy(
				spec({
					id: "cf-anthropic/claude-opus-4-8",
					name: "Claude Opus 4.8",
					provider: "cf-anthropic",
					baseUrl: "https://opencode.cloudflare.dev/anthropic",
				}),
			).compat.replayUnsignedThinking,
		).toBe(true);
	});

	it("demotes unsigned thinking on the Cloudflare AI Gateway `/anthropic` route (known signing host)", () => {
		const compat = resolveModelPolicy(
			spec({
				provider: "cloudflare-ai-gateway",
				baseUrl: "https://gateway.ai.cloudflare.com/v1/acct123/gate/anthropic",
			}),
		).compat;
		expect(compat.replayUnsignedThinking).toBe(false);
		expect(compat.signingEndpoint).toBe(true);
		expect(compat.officialEndpoint).toBe(false);
	});

	it("demotes unsigned thinking on Google Vertex's publishers/anthropic route (known signing host)", () => {
		const compat = resolveModelPolicy(
			spec({
				provider: "google-vertex",
				baseUrl:
					"https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/anthropic/models/claude-sonnet-4@20250514:streamRawPredict",
				id: "claude-sonnet-4@20250514",
			}),
		).compat;
		expect(compat.replayUnsignedThinking).toBe(false);
		expect(compat.signingEndpoint).toBe(true);
		expect(compat.officialEndpoint).toBe(false);
	});

	it("demotes unsigned thinking on AWS Bedrock's anthropic runtime (known signing host)", () => {
		const compat = resolveModelPolicy(
			spec({
				provider: "custom-bedrock",
				baseUrl:
					"https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-opus-4-8-v1:0/invoke-with-response-stream",
				id: "anthropic.claude-opus-4-8-v1:0",
			}),
		).compat;
		expect(compat.replayUnsignedThinking).toBe(false);
		expect(compat.signingEndpoint).toBe(true);
		expect(compat.officialEndpoint).toBe(false);
	});

	it("demotes unsigned thinking on Azure AI Inference / Foundry Anthropic routes (known signing host)", () => {
		for (const baseUrl of [
			"https://my-project.inference.ai.azure.com/anthropic/v1",
			"https://foundry-project.services.ai.azure.com/anthropic/v1",
		]) {
			const compat = resolveModelPolicy(spec({ provider: "custom-azure", baseUrl })).compat;
			expect(compat.replayUnsignedThinking).toBe(false);
			expect(compat.signingEndpoint).toBe(true);
			expect(compat.officialEndpoint).toBe(false);
		}
	});

	it("honors explicit `compat.replayUnsignedThinking: false` on custom signing proxies", () => {
		expect(
			resolveModelPolicy(spec({ compat: { replayUnsignedThinking: false } })).compat.replayUnsignedThinking,
		).toBe(false);
	});

	it("preserves native unsigned-thinking replay for the Umans coding-plan anthropic proxy", () => {
		const compat = resolveModelPolicy(
			spec({ provider: "umans", baseUrl: "https://api.code.umans.ai/anthropic", id: "glm-5.2" }),
		).compat;
		expect(compat.replayUnsignedThinking).toBe(true);
	});

	it("preserves native unsigned-thinking replay for MiniMax's Anthropic-messages proxies", () => {
		expect(
			resolveModelPolicy(
				spec({ provider: "minimax", baseUrl: "https://api.minimax.io/anthropic", id: "minimax-m2" }),
			).compat.replayUnsignedThinking,
		).toBe(true);
		expect(
			resolveModelPolicy(
				spec({ provider: "minimax-cn", baseUrl: "https://api.minimaxi.com/anthropic", id: "minimax-m2" }),
			).compat.replayUnsignedThinking,
		).toBe(true);
	});

	it("still demotes unsigned thinking on non-reasoning custom endpoints", () => {
		expect(resolveModelPolicy(spec({ reasoning: false })).compat.replayUnsignedThinking).toBe(false);
	});
});
