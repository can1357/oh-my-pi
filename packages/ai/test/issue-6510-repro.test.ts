import { describe, expect, it } from "bun:test";
import { buildAnthropicClientOptions, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * Repro for #6510 — every Claude (`anthropic-messages`) model on the
 * `opencode-zen` provider fails with `401 {"type":"error","error":
 * {"type":"AuthError","message":"Missing API key."}}` while OpenAI-format
 * models on the same provider work with the same stored credential.
 *
 * Root cause: `buildAnthropicClientOptions` special-cased `opencode-zen` to
 * bearer-only auth (`apiKey: null`, keeping the auto-built `Authorization`
 * header), but the Zen Anthropic gateway requires `x-api-key` and rejects
 * bearer-only requests. The sibling `opencode-go`/`umans` providers on the
 * same api-key login flow already send `X-Api-Key`.
 *
 * Secondary: once auth works, thinking requests through Zen 400 on several
 * model families because omp unconditionally attaches `context_management`
 * (`clear_thinking_20251015`), which the Zen Anthropic proxy rejects as an
 * unrecognized field — the same failure mode already handled for Copilot.
 */
const ZEN_ANTHROPIC_MODEL: Model<"anthropic-messages"> = buildModel({
	id: "claude-haiku-4-5",
	name: "Claude Haiku 4.5",
	api: "anthropic-messages",
	provider: "opencode-zen",
	baseUrl: "https://opencode.ai/zen/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
} as ModelSpec<"anthropic-messages">);

describe("issue #6510 — opencode-zen Anthropic auth + context_management", () => {
	it("authenticates Zen Claude models with X-Api-Key, not bearer-only", () => {
		const options = buildAnthropicClientOptions({
			model: ZEN_ANTHROPIC_MODEL,
			apiKey: "sk-zen-test",
			stream: true,
		});

		// The client adds `X-Api-Key` from `apiKey`; the bearer `Authorization`
		// header must not be sent (Zen's Anthropic gateway rejects it).
		expect(options.apiKey).toBe("sk-zen-test");
		expect(options.defaultHeaders.Authorization).toBeUndefined();
	});

	it("omits context_management and its beta on Zen thinking requests", async () => {
		let capturedBeta: string | null = null;
		const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
			capturedBeta = new Headers(init?.headers).get("anthropic-beta");
			return new Response(
				JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;
		const { promise, resolve } = Promise.withResolvers<unknown>();
		await streamAnthropic(
			ZEN_ANTHROPIC_MODEL,
			{ systemPrompt: [], messages: [{ role: "user", content: "continue", timestamp: 0 }] },
			{
				apiKey: "sk-zen-test",
				thinkingEnabled: true,
				fetch: fetchMock,
				onPayload: payload => resolve(payload),
			},
		).result();

		const payload = (await promise) as {
			thinking?: { type?: string };
			context_management?: unknown;
		};
		expect(payload.thinking?.type).toBe("enabled");
		expect(payload.context_management).toBeUndefined();
		expect(capturedBeta ?? "").not.toContain("context-management-2025-06-27");
	});
});
