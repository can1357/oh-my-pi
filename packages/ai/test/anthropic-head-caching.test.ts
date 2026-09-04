/**
 * Unit test: the general (API-key, non-OAuth) Anthropic path must anchor a
 * cache breakpoint on the stable request head — the last system block and the
 * last tool definition — in addition to the moving message tail. Without the
 * head anchor, tail churn re-writes the whole tools+system prefix uncached,
 * which is the prompt-cache hit-rate regression this patch fixes.
 *
 * The canonical cache order is tools -> system -> messages and Anthropic allows
 * at most 4 breakpoints per request, so we also assert the total stays within
 * budget and that head caching is gated off when caching is disabled.
 *
 * No network: a capturing `fetch` records the serialized wire body and returns
 * a 400 so the request short-circuits.
 */
import { describe, expect, it } from "bun:test";
import type { MessageCreateParams } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { CacheRetention, Context, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const MODEL_SPEC: ModelSpec<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const MODEL: Model<"anthropic-messages"> = buildModel(MODEL_SPEC);

const CONTEXT: Context = {
	systemPrompt: ["You are a precise assistant.", "Follow the house style guide."],
	messages: [{ role: "user", content: "Use the tools", timestamp: 1 }],
	tools: [
		{
			name: "lookup",
			description: "Lookup a value",
			parameters: { type: "object", properties: {}, additionalProperties: false },
		},
		{
			name: "compute",
			description: "Compute a value",
			parameters: { type: "object", properties: {}, additionalProperties: false },
		},
	],
};

async function captureWireBody(cacheRetention?: CacheRetention): Promise<MessageCreateParams> {
	let body: MessageCreateParams | undefined;
	const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
		body = JSON.parse(String(init?.body ?? "{}")) as MessageCreateParams;
		return new Response(
			JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}) as typeof fetch;

	await streamAnthropic(MODEL, CONTEXT, {
		apiKey: "sk-ant-api-test",
		...(cacheRetention ? { cacheRetention } : {}),
		fetch: fetchMock,
	})
		.result()
		.catch(() => undefined);

	if (!body) throw new Error("wire body was not captured");
	return body;
}

function countCacheBreakpoints(body: MessageCreateParams): number {
	let count = 0;
	for (const block of body.system ?? []) {
		if (typeof block !== "string" && block.cache_control != null) count++;
	}
	for (const tool of body.tools ?? []) {
		if ((tool as { cache_control?: unknown }).cache_control != null) count++;
	}
	for (const message of body.messages ?? []) {
		if (Array.isArray(message.content)) {
			for (const block of message.content) {
				if ((block as { cache_control?: unknown }).cache_control != null) count++;
			}
		}
	}
	return count;
}

describe("anthropic head caching (general API-key path)", () => {
	it("anchors cache_control on the last system block", async () => {
		const body = await captureWireBody();
		const system = body.system;
		if (!Array.isArray(system)) throw new Error("expected system blocks array");

		const last = system[system.length - 1];
		expect(typeof last === "string" ? undefined : last.cache_control?.type).toBe("ephemeral");

		// Only the final system block is anchored, not every block.
		const earlier = system[0];
		expect(typeof earlier === "string" ? undefined : earlier.cache_control).toBeUndefined();
	});

	it("anchors cache_control on the last tool definition", async () => {
		const body = await captureWireBody();
		const tools = body.tools ?? [];
		expect(tools.length).toBeGreaterThan(1);

		const last = tools[tools.length - 1] as { cache_control?: { type?: string } };
		expect(last.cache_control?.type).toBe("ephemeral");

		// Only the final tool is anchored, not every tool.
		const first = tools[0] as { cache_control?: unknown };
		expect(first.cache_control).toBeUndefined();
	});

	it("preserves the moving message-tail breakpoint", async () => {
		const body = await captureWireBody();
		const trailing = body.messages[body.messages.length - 1];
		expect(Array.isArray(trailing.content)).toBe(true);
		if (!Array.isArray(trailing.content)) return;
		const lastBlock = trailing.content[trailing.content.length - 1] as { cache_control?: { type?: string } };
		expect(lastBlock.cache_control?.type).toBe("ephemeral");
	});

	it("stays within Anthropic's 4-breakpoint budget", async () => {
		const body = await captureWireBody();
		expect(countCacheBreakpoints(body)).toBeLessThanOrEqual(4);
	});

	it("adds no breakpoints when caching is disabled", async () => {
		const body = await captureWireBody("none");
		expect(countCacheBreakpoints(body)).toBe(0);
	});
});
