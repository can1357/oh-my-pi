import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AnthropicCompat, AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

/**
 * A direct Anthropic model carrying the disabled-thinking dialect a KDL route
 * rule would assign (these axes are rule-only, so they layer onto the resolved compat).
 */
function model(id: string, compat: AnthropicCompat = {}): Model<"anthropic-messages"> {
	const built = buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
	return { ...built, compat: { ...built.compat, ...compat } };
}

/** A thinking-led tool round trip, then a new user turn. */
function thinkingLedHistory(id: string): Context {
	return {
		messages: [
			{ role: "user", content: "Read probe.txt.", timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Read it.", thinkingSignature: "sig" },
					{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "probe.txt" } },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: id,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "toolu_1",
				toolName: "read",
				content: [{ type: "text", text: "nonce" }],
				isError: false,
				timestamp: 3,
			},
		],
		tools: [{ name: "read", description: "Read a file.", parameters: { type: "object", properties: {} } }],
	};
}

interface Payload {
	thinking?: { type: string };
	output_config?: { effort?: string };
	messages: Array<{ role: string; content: string | Array<{ type: string }> }>;
}

async function payloadFor(target: Model<"anthropic-messages">, context: Context): Promise<Payload> {
	const controller = new AbortController();
	controller.abort();
	let payload: unknown;
	await streamAnthropic(target, context, {
		apiKey: "sk-ant-api-test",
		signal: controller.signal,
		thinkingEnabled: false,
		onPayload: captured => {
			payload = captured;
		},
	}).result();
	if (!payload) throw new Error("expected a built payload");
	return payload as Payload;
}

const assistantBlockTypes = (payload: Payload) =>
	payload.messages
		.filter(message => message.role === "assistant")
		.flatMap(message => (Array.isArray(message.content) ? message.content.map(block => block.type) : []));

describe("Anthropic disabled-thinking compat", () => {
	it("sends between_tools with the pinned effort when the route declares that disabled form", async () => {
		const payload = await payloadFor(
			model("claude-sonnet-5-5", { disabledThinking: "between-tools", betweenToolsEffort: "high" }),
			thinkingLedHistory("claude-sonnet-5-5"),
		);
		expect(payload.thinking).toEqual({ type: "between_tools" });
		expect(payload.output_config?.effort).toBe("high");
	});

	it("pins the declared effort on the model's own between_tools fallback too", async () => {
		const payload = await payloadFor(
			model("claude-sonnet-5-5", { betweenToolsEffort: "medium" }),
			thinkingLedHistory("claude-sonnet-5-5"),
		);
		expect(payload.thinking).toEqual({ type: "between_tools" });
		expect(payload.output_config?.effort).toBe("medium");
	});

	it("replays history without thinking blocks when a stripping route sends disabled", async () => {
		const payload = await payloadFor(
			model("claude-opus-4-8", { disabledThinking: "disabled", stripThinkingHistory: true }),
			thinkingLedHistory("claude-opus-4-8"),
		);
		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(assistantBlockTypes(payload)).toEqual(["tool_use"]);
	});

	it("keeps replayed thinking on disabled turns for routes without the strip contract", async () => {
		const payload = await payloadFor(
			model("claude-opus-4-8", { disabledThinking: "disabled" }),
			thinkingLedHistory("claude-opus-4-8"),
		);
		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(assistantBlockTypes(payload)).toEqual(["thinking", "tool_use"]);
	});
});

/** Haiku 5.5 on a binding-controls host; the request is captured at the fetch boundary. */
function haiku(provider: "anthropic" | "cloudflare-ai-gateway", id = "claude-haiku-5-5"): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider,
		baseUrl:
			provider === "anthropic"
				? "https://api.anthropic.com"
				: "https://gateway.ai.cloudflare.com/v1/account-id/my-gateway/anthropic",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
}

async function haikuRequest(
	target: Model<"anthropic-messages">,
	messages: Context["messages"],
	reasoning: Effort | undefined,
): Promise<{ body: Payload & { thinking?: { type: string; block_binding?: unknown } }; beta: string }> {
	let captured: { body: Payload & { thinking?: { type: string; block_binding?: unknown } }; beta: string } | undefined;
	await streamAnthropic(
		target,
		{ messages },
		{
			apiKey: "sk-ant-api-test",
			thinkingEnabled: reasoning !== undefined,
			reasoning,
			fetch: async (_url, init) => {
				captured ??= {
					body: JSON.parse(String(init?.body)),
					beta: new Headers(init?.headers).get("anthropic-beta") ?? "",
				};
				return Response.json({ error: { type: "invalid_request_error", message: "captured" } }, { status: 400 });
			},
		},
	).result();
	if (!captured) throw new Error("expected a captured request");
	return captured;
}

describe("Anthropic thinking-binding beta follows block_binding", () => {
	it.each(["anthropic", "cloudflare-ai-gateway"] as const)(
		"%s Haiku 5.5 Off sends neither, but its xhigh fallback to adaptive sends both",
		async provider => {
			const target = haiku(provider);
			const off = await haikuRequest(target, [{ role: "user", content: "q0", timestamp: 1 }], undefined);
			expect(off.body.thinking).toEqual({ type: "disabled" });
			expect(off.beta).not.toContain("thinking-binding-controls-2026-08-01");

			const controller = new AbortController();
			controller.abort();
			const first: AssistantMessage = await streamAnthropic(
				target,
				{ messages: [{ role: "user", content: "q0", timestamp: 1 }] },
				{
					apiKey: "sk-ant-api-test",
					signal: controller.signal,
					thinkingEnabled: true,
					reasoning: Effort.XHigh,
				},
			).result();
			const history: Context["messages"] = [
				{ role: "user", content: "q0", timestamp: 1 },
				{ ...first, content: [{ type: "text", text: "ok" }], stopReason: "stop", timestamp: 2 },
				{ role: "user", content: "q1", timestamp: 3 },
			];
			const fallback = await haikuRequest(target, history, undefined);
			expect(fallback.body.thinking?.type).toBe("adaptive");
			expect(fallback.body.thinking?.block_binding).toEqual({ prefix_mismatch_behavior: "drop_block" });
			expect(fallback.beta).toContain("thinking-binding-controls-2026-08-01");
		},
	);

	it.each(["anthropic", "cloudflare-ai-gateway"] as const)(
		"%s Sonnet 5.5 Off sends between_tools without binding, and after xhigh falls back to default adaptive, still unbound",
		async provider => {
			const target = haiku(provider, "claude-sonnet-5-5");
			const off = await haikuRequest(target, [{ role: "user", content: "q0", timestamp: 1 }], undefined);
			expect(off.body.thinking).toEqual({ type: "between_tools" });
			expect(off.beta).not.toContain("thinking-binding-controls-2026-08-01");

			const controller = new AbortController();
			controller.abort();
			const first: AssistantMessage = await streamAnthropic(
				target,
				{ messages: [{ role: "user", content: "q0", timestamp: 1 }] },
				{ apiKey: "sk-ant-api-test", signal: controller.signal, thinkingEnabled: true, reasoning: Effort.XHigh },
			).result();
			const fallback = await haikuRequest(
				target,
				[
					{ role: "user", content: "q0", timestamp: 1 },
					{ ...first, content: [{ type: "text", text: "ok" }], stopReason: "stop", timestamp: 2 },
					{ role: "user", content: "q1", timestamp: 3 },
				],
				undefined,
			);
			// The API's default adaptive thinking (field omitted) carries no binding, so no beta.
			expect(fallback.body.thinking).toBeUndefined();
			expect(fallback.beta).not.toContain("thinking-binding-controls-2026-08-01");
		},
	);

	it.each([
		["adds block_binding", { prefix_mismatch_behavior: "drop_block" }, true],
		["leaves block_binding explicitly undefined", undefined, false],
	] as const)("an onPayload hook that %s gets the binding beta: %p", async (_label, binding, expected) => {
		const target = haiku("anthropic");
		let beta = "";
		await streamAnthropic(
			target,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: "sk-ant-api-test",
				thinkingEnabled: false,
				onPayload: payload => ({
					...(payload as Record<string, unknown>),
					thinking: { type: "adaptive", block_binding: binding },
				}),
				fetch: async (_url, init) => {
					beta = new Headers(init?.headers).get("anthropic-beta") ?? "";
					return Response.json({ error: { type: "invalid_request_error", message: "captured" } }, { status: 400 });
				},
			},
		).result();
		expect(beta.includes("thinking-binding-controls-2026-08-01")).toBe(expected);
	});

	const VERTEX_RAW_PREDICT =
		"https://us-east5-aiplatform.googleapis.com/v1/projects/test/locations/us-east5/publishers/anthropic/models/claude-fable-5-1:streamRawPredict";
	const vertexFable = buildModel({
		id: "claude-fable-5-1",
		name: "claude-fable-5-1",
		api: "anthropic-messages",
		provider: "google-vertex",
		baseUrl: VERTEX_RAW_PREDICT,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
	it.each([
		[
			"a hook removes block_binding",
			(payload: unknown) => {
				const p = payload as Record<string, unknown>;
				const { block_binding: _dropped, ...thinking } = p.thinking as Record<string, unknown>;
				return { ...p, thinking };
			},
			false,
		],
		[
			"a hook switches thinking to disabled",
			(payload: unknown) => ({ ...(payload as Record<string, unknown>), thinking: { type: "disabled" } }),
			false,
		],
		["no hook runs on a bound request", undefined, true],
		[
			"a hook supplies the token without a binding",
			(payload: unknown) => ({
				...(payload as Record<string, unknown>),
				thinking: { type: "disabled" },
				anthropic_beta: ["thinking-binding-controls-2026-08-01"],
			}),
			true,
		],
	] as const)(
		"Vertex rawPredict carries the binding token in anthropic_beta when %s: %p",
		async (_label, onPayload, expected) => {
			let body: { anthropic_beta?: string[] } = {};
			await streamAnthropic(
				vertexFable,
				{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
				{
					apiKey: "sk-ant-api-test",
					thinkingEnabled: true,
					reasoning: Effort.High,
					...(onPayload ? { onPayload } : {}),
					fetch: async (_url, init) => {
						body = JSON.parse(String(init?.body));
						return Response.json(
							{ error: { type: "invalid_request_error", message: "captured" } },
							{ status: 400 },
						);
					},
				},
			).result();
			expect(body.anthropic_beta?.includes("thinking-binding-controls-2026-08-01") ?? false).toBe(expected);
		},
	);
});
