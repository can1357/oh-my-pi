/**
 * Fire Pass (Fireworks Kimi K2.6 Turbo subscription) wiring.
 *
 * Fire Pass keys (`fpk_…`) authorize only the `accounts/fireworks/routers/kimi-k2p6-turbo`
 * router and reject `/v1/models`. The bundled catalog stores a friendly public id
 * (`kimi-k2.6-turbo`) and the openai-completions provider translates it to the wire
 * form at request time.
 */
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

function sseResponse(events: unknown[]): Response {
	const payload = `${events.map(e => `data: ${typeof e === "string" ? e : JSON.stringify(e)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("Fire Pass provider", () => {
	it("ships a bundled Kimi K2.6 Turbo entry on the firepass provider", () => {
		const model = getBundledModel("firepass", "kimi-k2.6-turbo");
		expect(model).toBeDefined();
		expect(model.provider).toBe("firepass");
		expect(model.api).toBe("openai-completions");
		expect(model.baseUrl).toBe("https://api.fireworks.ai/inference/v1");
		expect(model.reasoning).toBe(true);
	});

	it("translates the friendly id to the router wire id when calling chat completions", async () => {
		const model = getBundledModel<"openai-completions">("firepass", "kimi-k2.6-turbo");
		const captured: { body: string | null } = { body: null };
		const fetchMock: FetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
			captured.body = typeof init?.body === "string" ? init.body : null;
			return sseResponse([
				{ choices: [{ delta: { content: "ok" }, index: 0 }] },
				{ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
				"[DONE]",
			]);
		};

		const context: Context = {
			systemPrompt: [],
			messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
		};
		const stream = streamOpenAICompletions(model as Model<"openai-completions">, context, {
			apiKey: "fpk_test",
			fetch: fetchMock,
		});
		for await (const _event of stream) {
			/* drain */
		}

		expect(captured.body).not.toBeNull();
		const parsed = JSON.parse(captured.body ?? "{}") as { model?: unknown };
		expect(parsed.model).toBe("accounts/fireworks/routers/kimi-k2p6-turbo");
	});

	it("forwards the catalog-exposed xhigh effort verbatim to the Fire Pass router", async () => {
		// The Fire Pass router's own validation message enumerates the accepted
		// reasoning_effort set as `low | medium | high | xhigh | max | none`, and
		// `xhigh` is a distinct tier from `max` (different reasoning-token budgets
		// for the same prompt). The bundled entry must therefore advertise xhigh
		// without a thinking effortMap that would silently downgrade it to max —
		// see PR #1199 discussion r3265122224 for the live API capture.
		const model = getBundledModel<"openai-completions">("firepass", "kimi-k2.6-turbo");
		expect(model.thinking?.effortMap?.xhigh).toBeUndefined();

		const captured: { body: string | null } = { body: null };
		const fetchMock: FetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
			captured.body = typeof init?.body === "string" ? init.body : null;
			return sseResponse([
				{ choices: [{ delta: { content: "ok" }, index: 0 }] },
				{ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
				"[DONE]",
			]);
		};

		const context: Context = {
			systemPrompt: [],
			messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
		};
		const stream = streamOpenAICompletions(model as Model<"openai-completions">, context, {
			apiKey: "fpk_test",
			reasoning: "xhigh",
			fetch: fetchMock,
		});
		for await (const _event of stream) {
			/* drain */
		}

		expect(captured.body).not.toBeNull();
		const parsed = JSON.parse(captured.body ?? "{}") as { reasoning_effort?: unknown };
		expect(parsed.reasoning_effort).toBe("xhigh");
	});

	it("falls back to the catalog max_tokens when the caller omits it (Kimi K2 docs guidance)", async () => {
		// https://docs.fireworks.ai/models/kimi-k2 — "always set max_tokens explicitly" because
		// the Kimi K2 family otherwise emits very long reasoning traces. The openai-completions
		// provider injects the catalog default via its Kimi-family safety net; the firepass
		// catalog id (`kimi-k2.6-turbo`) and wire id (`accounts/fireworks/routers/kimi-k2p6-turbo`)
		// must both fall under that net so users never hit the runaway path.
		const model = getBundledModel<"openai-completions">("firepass", "kimi-k2.6-turbo");
		expect(model.maxTokens).toBeGreaterThan(0);

		const captured: { body: string | null } = { body: null };
		const fetchMock: FetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
			captured.body = typeof init?.body === "string" ? init.body : null;
			return sseResponse([
				{ choices: [{ delta: { content: "ok" }, index: 0 }] },
				{ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
				"[DONE]",
			]);
		};

		const context: Context = {
			systemPrompt: [],
			messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
		};
		const stream = streamOpenAICompletions(model as Model<"openai-completions">, context, {
			apiKey: "fpk_test",
			fetch: fetchMock,
			// Intentionally omit maxTokens — the provider must inject the catalog default.
		});
		for await (const _event of stream) {
			/* drain */
		}

		expect(captured.body).not.toBeNull();
		const parsed = JSON.parse(captured.body ?? "{}") as { max_tokens?: unknown };
		expect(parsed.max_tokens).toBe(model.maxTokens);
	});

	it("applies the Kimi max_tokens default to canonical Fire Pass router ids", async () => {
		const bundled = getBundledModel<"openai-completions">("firepass", "kimi-k2.6-turbo");
		const model: Model<"openai-completions"> = {
			...bundled,
			id: "accounts/fireworks/routers/kimi-k2p6-turbo",
		};
		const captured: { body: string | null } = { body: null };
		const fetchMock: FetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
			captured.body = typeof init?.body === "string" ? init.body : null;
			return sseResponse([
				{ choices: [{ delta: { content: "ok" }, index: 0 }] },
				{ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
				"[DONE]",
			]);
		};

		const context: Context = {
			systemPrompt: [],
			messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
		};
		const stream = streamOpenAICompletions(model, context, {
			apiKey: "fpk_test",
			fetch: fetchMock,
		});
		for await (const _event of stream) {
			/* drain */
		}

		expect(captured.body).not.toBeNull();
		const parsed = JSON.parse(captured.body ?? "{}") as { max_tokens?: unknown; model?: unknown };
		expect(parsed.model).toBe("accounts/fireworks/routers/kimi-k2p6-turbo");
		expect(parsed.max_tokens).toBe(model.maxTokens);
	});
});
