/**
 * Gateway clients request efforts in their own vocabulary. omp's own
 * `lowest-effort` reasoning-off sends `reasoning_effort: "minimal"` to a
 * generic OpenAI-compatible endpoint, but the gateway may resolve that id to a
 * Claude model whose ladder starts at `low`. The gateway must serve the nearest
 * supported tier instead of failing the request before it reaches upstream.
 */
import { describe, expect, it } from "bun:test";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import type { Api, Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ThinkingBudgets } from "@oh-my-pi/pi-catalog/types";
import { withOfficialAnthropicEndpoint } from "./helpers";
import { anthropicChunks, type CapturedRequest, captureFetch, completionsChunks } from "./helpers/factory-droid";

withOfficialAnthropicEndpoint();

const CONTEXT: Context = { messages: [{ role: "user", content: "Hi", timestamp: 1 }] };

const CLAUDE = buildModel({
	id: "claude-haiku-5-5",
	name: "claude-haiku-5-5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

async function requestUpstream(
	model: Model<Api>,
	chunks: string[],
	route: "/v1/chat/completions" | "/v1/pi/stream",
	effort: string,
	thinkingBudgets?: ThinkingBudgets,
): Promise<{ status: number; upstream: CapturedRequest[] }> {
	const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
	storage.keys.setRuntime(model.provider, "test-key");
	const upstream: CapturedRequest[] = [];
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["test-token"],
		storage,
		resolveModel: () => model,
		fetch: captureFetch(upstream, chunks),
		version: "test",
	});
	try {
		const response = await fetch(`${gateway.url}${route}`, {
			method: "POST",
			headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
			body: JSON.stringify(
				route === "/v1/pi/stream"
					? { modelId: model.id, context: CONTEXT, options: { reasoning: effort, thinkingBudgets }, stream: false }
					: {
							model: `${model.provider}/${model.id}`,
							messages: [{ role: "user", content: "Hi" }],
							reasoning_effort: effort,
							stream: false,
						},
			),
		});
		await response.body?.cancel();
		return { status: response.status, upstream };
	} finally {
		await gateway.close();
		storage.close();
	}
}

describe("auth-gateway reasoning effort", () => {
	it.each(["/v1/chat/completions", "/v1/pi/stream"] as const)(
		"serves an effort below the model's ladder at its lowest tier through %s",
		async route => {
			const { status, upstream } = await requestUpstream(CLAUDE, anthropicChunks("ok"), route, "minimal");

			expect(status).toBe(200);
			expect(upstream).toHaveLength(1);
			expect(upstream[0].body.output_config).toMatchObject({ effort: "low" });
		},
	);

	it("honors a zero budget on the requested tier after clamping", async () => {
		const { status, upstream } = await requestUpstream(CLAUDE, anthropicChunks("ok"), "/v1/pi/stream", "minimal", {
			minimal: 0,
		});
		expect(status).toBe(200);
		expect(upstream[0].body.thinking).toEqual({ type: "disabled" });
	});

	it.each([
		{ name: "carries the requested tier's positive budget", budgets: { minimal: 2048 }, expected: 2048 },
		{ name: "keeps the destination tier's positive override", budgets: { minimal: 0, low: 3072 }, expected: 3072 },
		{ name: "keeps the destination tier's zero override", budgets: { minimal: 2048, low: 0 }, expected: 0 },
	])("$name when clamping a budget-based model", async ({ budgets, expected }) => {
		const model = buildModel({
			id: "budget-test-model",
			name: "Budget test model",
			api: "anthropic-messages",
			provider: "budget-test-provider",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			thinking: { mode: "budget", efforts: [Effort.Low, Effort.High] },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8192,
		});
		const { status, upstream } = await requestUpstream(
			model,
			anthropicChunks("ok"),
			"/v1/pi/stream",
			"minimal",
			budgets,
		);
		expect(status).toBe(200);
		expect(upstream[0].body.thinking).toMatchObject(
			expected === 0 ? { type: "disabled" } : { type: "enabled", budget_tokens: expected },
		);
	});

	it("keeps the catalog's effort mapping for an effort outside the ladder", async () => {
		// Kimi K3's ladder is low/high/max; the catalog maps `medium` up to `high`.
		// Clamping first would downgrade it to `low`.
		const kimi = getBundledModel("fireworks", "kimi-k3");
		const { status, upstream } = await requestUpstream(
			kimi,
			completionsChunks("ok", kimi.id),
			"/v1/chat/completions",
			"medium",
		);

		expect(status).toBe(200);
		expect(upstream[0].body.reasoning_effort).toBe("high");
	});
});
