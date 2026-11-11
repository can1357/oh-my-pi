/**
 * OpenRouter sticky-session wiring for the Chat Completions transport.
 *
 * Contract: when the host is OpenRouter, chat completions must send the same
 * normalized `session_id` the Responses transport derives via
 * `getOpenRouterResponsesSessionId`, and a manual `provider.order` must warn
 * (once per process) that upstream skips session-affinity endpoint
 * prioritization while the order is active.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import {
	applyOpenAIGatewayRouting,
	getOpenRouterResponsesSessionId,
	normalizeOpenRouterResponsesSessionId,
	type OpenAIGatewayRoutingCompat,
	type OpenAIGatewayRoutingParams,
	resetOpenRouterOrderSessionAffinityWarned,
} from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { Context, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { logger } from "@oh-my-pi/pi-utils";

function sseResponse(events: unknown[]): Response {
	const payload = `${events.map(e => `data: ${typeof e === "string" ? e : JSON.stringify(e)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function makeCompletionsModel(overrides: Partial<ModelSpec<"openai-completions">> = {}): Model<"openai-completions"> {
	return buildModel({
		id: "anthropic/claude-sonnet-4.5",
		name: "Claude Sonnet 4.5 (OpenRouter)",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
		...overrides,
	} as ModelSpec<"openai-completions">);
}

async function captureChatBody(
	model: Model<"openai-completions">,
	options: { sessionId?: string; cacheRetention?: "none" } = {},
): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
		body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
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
	for await (const _event of streamOpenAICompletions(model, context, {
		apiKey: "test",
		fetch: fetchMock,
		...options,
	})) {
		break;
	}
	if (!body) throw new Error("expected a captured chat-completions request body");
	return body;
}

describe("OpenRouter completions sticky sessions", () => {
	it("sends the normalized session_id the Responses transport would send", async () => {
		const sessionId = "0190fb1e-0000-7000-8000-000000000001";
		const body = await captureChatBody(makeCompletionsModel(), { sessionId });

		// Same value the Responses path emits (openai-responses.ts uses
		// getOpenRouterResponsesSessionId), i.e. the shared stable-id normalization.
		expect(body.session_id).toBe(normalizeOpenRouterResponsesSessionId(sessionId));
		expect(body.session_id).toBe(getOpenRouterResponsesSessionId({ sessionId }));
	});

	it("omits session_id for non-OpenRouter hosts even when a session id is supplied", async () => {
		const plain = makeCompletionsModel({ provider: "openai", baseUrl: "https://api.openai.com/v1" });
		const body = await captureChatBody(plain, { sessionId: "0190fb1e-0000-7000-8000-000000000001" });

		expect("session_id" in body).toBe(false);
	});

	it("omits session_id when the caller opts out via cacheRetention none", async () => {
		const body = await captureChatBody(makeCompletionsModel(), {
			sessionId: "0190fb1e-0000-7000-8000-000000000001",
			cacheRetention: "none",
		});

		expect("session_id" in body).toBe(false);
	});
});

describe("applyOpenAIGatewayRouting order/session-affinity warning", () => {
	beforeEach(() => {
		resetOpenRouterOrderSessionAffinityWarned();
	});

	// Restore the module-global latch even after the LAST test in this file so
	// subsequently-run files in the same Bun worker start clean.
	afterEach(() => {
		resetOpenRouterOrderSessionAffinityWarned();
	});

	it("does not warn when the host is not OpenRouter even with an order set", () => {
		const warnSpy = spyOn(logger, "warn");
		try {
			const params: OpenAIGatewayRoutingParams = {};
			applyOpenAIGatewayRouting(params, {
				isOpenRouterHost: false,
				openRouterRouting: { order: ["anthropic", "openai"] },
			});

			expect(warnSpy).not.toHaveBeenCalled();
			expect(params.provider).toBeUndefined();
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("warns exactly once per process even when routing runs twice", () => {
		const warnSpy = spyOn(logger, "warn");
		try {
			const params: OpenAIGatewayRoutingParams = {};
			const compat: OpenAIGatewayRoutingCompat = {
				isOpenRouterHost: true,
				openRouterRouting: { order: ["anthropic", "openai"] },
			};

			applyOpenAIGatewayRouting(params, compat, true, { sessionId: "0190fb1e-0000-7000-8000-000000000001" });
			applyOpenAIGatewayRouting(params, compat, true, { sessionId: "0190fb1e-0000-7000-8000-000000000001" });

			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(String(warnSpy.mock.calls[0]?.[0])).toContain("provider.order");
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("does not warn when no sessionId is supplied and does not consume the once-per-process latch", () => {
		const warnSpy = spyOn(logger, "warn");
		try {
			const params: OpenAIGatewayRoutingParams = {};
			const compat: OpenAIGatewayRoutingCompat = {
				isOpenRouterHost: true,
				openRouterRouting: { order: ["anthropic", "openai"] },
			};

			applyOpenAIGatewayRouting(params, compat, true);
			expect(warnSpy).not.toHaveBeenCalled();

			// A later request WITH active session affinity must still see the warning.
			applyOpenAIGatewayRouting(params, compat, true, { sessionId: "0190fb1e-0000-7000-8000-000000000001" });
			expect(warnSpy).toHaveBeenCalledTimes(1);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("does not warn when caching is opted out via cacheRetention none", () => {
		const warnSpy = spyOn(logger, "warn");
		try {
			const params: OpenAIGatewayRoutingParams = {};
			const compat: OpenAIGatewayRoutingCompat = {
				isOpenRouterHost: true,
				openRouterRouting: { order: ["anthropic", "openai"] },
			};

			applyOpenAIGatewayRouting(params, compat, false, {
				sessionId: "0190fb1e-0000-7000-8000-000000000001",
				cacheRetention: "none",
			});
			expect(warnSpy).not.toHaveBeenCalled();

			// Same id with caching re-enabled still warns: the opt-out never latched.
			applyOpenAIGatewayRouting(params, compat, true, { sessionId: "0190fb1e-0000-7000-8000-000000000001" });
			expect(warnSpy).toHaveBeenCalledTimes(1);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("warns through the chat completions wire path only when the request carries session affinity", async () => {
		const warnSpy = spyOn(logger, "warn");
		try {
			resetOpenRouterOrderSessionAffinityWarned();
			const routedModel = makeCompletionsModel({
				compat: { openRouterRouting: { order: ["anthropic", "openai"] } },
			} as Partial<ModelSpec<"openai-completions">>);

			await captureChatBody(routedModel, { sessionId: "0190fb1e-0000-7000-8000-000000000001" });
			expect(warnSpy).toHaveBeenCalledTimes(1);

			// Without a session id there is nothing to degrade: no warning, no latch.
			resetOpenRouterOrderSessionAffinityWarned();
			warnSpy.mockClear();
			await captureChatBody(routedModel, {});
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});
});
