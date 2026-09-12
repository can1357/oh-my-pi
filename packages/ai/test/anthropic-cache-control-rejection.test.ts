/**
 * Regression: an Anthropic-compatible endpoint that does not implement prompt
 * caching rejects the `cache_control` field itself with a 400. A 400 is
 * terminal for the provider retry gate and the replay path re-sends a
 * byte-identical body, so such an endpoint used to break the turn outright.
 *
 * The provider must replay the request once without prompt-cache breakpoints,
 * remember the rejection for the rest of the session — scoped to the model and
 * to the endpoint the request reached, or to the injected client itself when it
 * publishes no endpoint — and stop advertising the extended-cache-ttl beta on
 * requests that carry no breakpoint at all.
 */
import { describe, expect, it } from "bun:test";
import { isCacheControlUnsupported } from "@oh-my-pi/pi-ai/error";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessagesClient, type AnthropicMessagesClientLike } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import type { MessageCreateParams } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import type { AssistantMessage, Context, FetchImpl, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withOfficialAnthropicEndpoint } from "./helpers";

const EXTENDED_CACHE_TTL_BETA = "extended-cache-ttl-2025-04-11";
const PROMPT_CACHING_SCOPE_BETA = "prompt-caching-scope-2026-01-05";

const MODEL: Model<"anthropic-messages"> = buildModel({
	id: "claude-sonnet-4-6",
	name: "Claude Sonnet 4.6",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const CONTEXT: Context = {
	systemPrompt: ["You are a precise assistant.", "Follow the house style guide."],
	messages: [{ role: "user", content: "Say hi", timestamp: 1 }],
	tools: [
		{
			name: "lookup",
			description: "Lookup a value",
			parameters: { type: "object", properties: {}, additionalProperties: false },
		},
	],
};

/** Shape a caching-unaware proxy returns: a 400 naming the field it refuses. */
function cacheControlRejectionResponse(): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "messages.0.content.0.cache_control: Extra inputs are not permitted",
			},
		}),
		{ status: 400, headers: { "Content-Type": "application/json" } },
	);
}

function successResponse(): Response {
	const events: Array<Record<string, unknown>> = [
		{ type: "message_start", message: { id: "msg_ok", usage: { input_tokens: 10, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { input_tokens: 10, output_tokens: 1 },
		},
		{ type: "message_stop" },
	];
	const body = `${events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "text/event-stream", "request-id": "req_cache_control_retry" },
	});
}

interface Capture {
	bodies: MessageCreateParams[];
	betaHeaders: string[];
}

function createFetch(capture: Capture, modes: Array<"reject" | "ok">): FetchImpl {
	return async (input, init) => {
		const raw = init?.body;
		const text = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : String(raw ?? "{}");
		capture.bodies.push(JSON.parse(text) as MessageCreateParams);
		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
		capture.betaHeaders.push(headers.get("anthropic-beta") ?? "");
		const mode = modes[capture.bodies.length - 1];
		if (mode === undefined) throw new Error(`unexpected request #${capture.bodies.length}`);
		return mode === "reject" ? cacheControlRejectionResponse() : successResponse();
	};
}

/**
 * A caching-unaware proxy modeled faithfully: every body that carries a
 * breakpoint anywhere is refused, so the turn can only complete once the
 * provider ships a body with none at all.
 */
function createBreakpointRejectingFetch(capture: Capture): FetchImpl {
	return async (input, init) => {
		const raw = init?.body;
		const text = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : String(raw ?? "{}");
		const body = JSON.parse(text) as MessageCreateParams;
		capture.bodies.push(body);
		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
		capture.betaHeaders.push(headers.get("anthropic-beta") ?? "");
		return countBreakpoints(body) > 0 ? cacheControlRejectionResponse() : successResponse();
	};
}

function runTurn(fetchImpl: FetchImpl, states: Map<string, ProviderSessionState>): Promise<AssistantMessage> {
	return streamAnthropic(MODEL, CONTEXT, {
		apiKey: "sk-ant-api-test",
		// `long` retention is the only path that adds the extended-cache-ttl beta,
		// so the header assertions below have something to observe.
		cacheRetention: "long",
		providerSessionState: states,
		fetch: fetchImpl,
	}).result();
}

/** The real transport, pointed at an arbitrary endpoint over the capturing fetch. */
function transportAt(baseURL: string, fetchImpl: FetchImpl): AnthropicMessagesClient {
	return new AnthropicMessagesClient({ apiKey: "sk-ant-api-test", baseURL, fetch: fetchImpl });
}

/**
 * An injected client whose transport is real but whose routing is unknowable:
 * it publishes no `baseURL`, exactly like a caller-owned proxy wrapper.
 */
function createOpaqueClient(baseURL: string, fetchImpl: FetchImpl): AnthropicMessagesClientLike {
	return { messages: transportAt(baseURL, fetchImpl).messages };
}

/** Every `cache_control` breakpoint on the wire, across tools, system and messages. */
function countBreakpoints(body: MessageCreateParams): number {
	let count = 0;
	for (const block of body.system ?? []) {
		if (typeof block !== "string" && block.cache_control != null) count++;
	}
	for (const tool of body.tools ?? []) {
		if ("cache_control" in tool && tool.cache_control != null) count++;
	}
	for (const message of body.messages ?? []) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if ("cache_control" in block && block.cache_control != null) count++;
		}
	}
	return count;
}

function makeStatusError(status: number, message: string): Error {
	const error = new Error(message) as Error & { status: number };
	error.status = status;
	return error;
}

withOfficialAnthropicEndpoint();

describe("Anthropic cache_control rejection fallback", () => {
	it("completes the turn by replaying once without prompt-cache breakpoints", async () => {
		const capture: Capture = { bodies: [], betaHeaders: [] };
		const states = new Map<string, ProviderSessionState>();

		const message = await runTurn(createFetch(capture, ["reject", "ok"]), states);

		expect(message.stopReason).toBe("stop");
		expect(message.errorMessage).toBeUndefined();
		expect(capture.bodies).toHaveLength(2);
		expect(countBreakpoints(capture.bodies[0])).toBeGreaterThan(0);
		expect(countBreakpoints(capture.bodies[1])).toBe(0);
		expect(message.disabledFeatures).toContain("prompt-cache");
	});

	it("omits breakpoints on the first attempt of a later turn in the same session", async () => {
		const capture: Capture = { bodies: [], betaHeaders: [] };
		const states = new Map<string, ProviderSessionState>();
		const fetchImpl = createFetch(capture, ["reject", "ok", "ok"]);

		await runTurn(fetchImpl, states);
		const second = await runTurn(fetchImpl, states);

		expect(second.stopReason).toBe("stop");
		// A third request only exists if the learned rejection kept the second
		// turn's first attempt from being rejected again.
		expect(capture.bodies).toHaveLength(3);
		expect(countBreakpoints(capture.bodies[2])).toBe(0);
	});

	it("stops advertising the extended-cache-ttl beta once breakpoints are dropped", async () => {
		const capture: Capture = { bodies: [], betaHeaders: [] };
		const states = new Map<string, ProviderSessionState>();
		const fetchImpl = createFetch(capture, ["reject", "ok", "ok"]);

		await runTurn(fetchImpl, states);
		await runTurn(fetchImpl, states);

		expect(capture.betaHeaders[0]).toContain(EXTENDED_CACHE_TTL_BETA);
		// The immediate retry, not just the next turn: the client's default
		// headers must be rebuilt alongside the body.
		expect(capture.betaHeaders[1]).not.toContain(EXTENDED_CACHE_TTL_BETA);
		expect(capture.betaHeaders[2]).not.toContain(EXTENDED_CACHE_TTL_BETA);
	});

	it("drops caller-supplied cache betas from the breakpoint-free retry", async () => {
		const capture: Capture = { bodies: [], betaHeaders: [] };
		const message = await streamAnthropic(MODEL, CONTEXT, {
			apiKey: "sk-ant-api-test",
			betas: [EXTENDED_CACHE_TTL_BETA, PROMPT_CACHING_SCOPE_BETA],
			providerSessionState: new Map<string, ProviderSessionState>(),
			fetch: createFetch(capture, ["reject", "ok"]),
		}).result();

		expect(message.stopReason).toBe("stop");
		expect(capture.bodies).toHaveLength(2);
		expect(capture.betaHeaders[0]).toContain(EXTENDED_CACHE_TTL_BETA);
		expect(capture.betaHeaders[0]).toContain(PROMPT_CACHING_SCOPE_BETA);
		expect(capture.betaHeaders[1]).not.toContain(EXTENDED_CACHE_TTL_BETA);
		expect(capture.betaHeaders[1]).not.toContain(PROMPT_CACHING_SCOPE_BETA);
	});

	// Two client shapes that both publish an endpoint: an SDK-shaped wrapper over
	// our transport, and the transport itself, which now reports the `baseURL`
	// its requests actually go to. Both must key their learning by that endpoint
	// rather than by the model's own routing.
	const endpointClients: Array<{
		label: string;
		create: (baseURL: string, fetchImpl: FetchImpl) => AnthropicMessagesClientLike;
	}> = [
		{
			label: "an SDK-shaped wrapper",
			create: (baseURL, fetchImpl) => ({ baseURL, messages: transportAt(baseURL, fetchImpl).messages }),
		},
		{
			label: "a real AnthropicMessagesClient",
			create: (baseURL, fetchImpl) => transportAt(baseURL, fetchImpl),
		},
	];

	for (const shape of endpointClients) {
		it(`keeps a rejection from ${shape.label} scoped to that client endpoint`, async () => {
			const capture: Capture = { bodies: [], betaHeaders: [] };
			const states = new Map<string, ProviderSessionState>();
			const fetchImpl = createFetch(capture, ["reject", "ok", "ok"]);
			const rejectingClient = shape.create("https://rejecting.example/v1", fetchImpl);
			const otherClient = shape.create("https://caching.example/v1", fetchImpl);

			const first = await streamAnthropic(MODEL, CONTEXT, {
				client: rejectingClient,
				providerSessionState: states,
			}).result();
			const other = await streamAnthropic(MODEL, CONTEXT, {
				client: otherClient,
				providerSessionState: states,
			}).result();

			expect(first.stopReason).toBe("stop");
			expect(other.stopReason).toBe("stop");
			expect(capture.bodies).toHaveLength(3);
			expect(countBreakpoints(capture.bodies[0])).toBeGreaterThan(0);
			expect(countBreakpoints(capture.bodies[1])).toBe(0);
			expect(countBreakpoints(capture.bodies[2])).toBeGreaterThan(0);
		});
	}

	it("keeps an opaque injected client's rejection off a later non-injected request", async () => {
		const capture: Capture = { bodies: [], betaHeaders: [] };
		const states = new Map<string, ProviderSessionState>();
		const fetchImpl = createFetch(capture, ["reject", "ok", "ok"]);

		const proxied = await streamAnthropic(MODEL, CONTEXT, {
			client: createOpaqueClient("https://opaque-proxy.example/v1", fetchImpl),
			providerSessionState: states,
		}).result();
		// Same model, same session state, no client: the official endpoint, which
		// the opaque proxy's refusal cannot speak for.
		const direct = await runTurn(fetchImpl, states);

		expect(proxied.stopReason).toBe("stop");
		expect(direct.stopReason).toBe("stop");
		expect(capture.bodies).toHaveLength(3);
		expect(countBreakpoints(capture.bodies[1])).toBe(0);
		expect(countBreakpoints(capture.bodies[2])).toBeGreaterThan(0);
		expect(direct.disabledFeatures ?? []).not.toContain("prompt-cache");
	});

	it("keeps two opaque injected clients from sharing the rejection", async () => {
		const capture: Capture = { bodies: [], betaHeaders: [] };
		const states = new Map<string, ProviderSessionState>();
		const fetchImpl = createFetch(capture, ["reject", "ok", "ok"]);
		const rejecting = createOpaqueClient("https://opaque-rejecting.example/v1", fetchImpl);
		const caching = createOpaqueClient("https://opaque-caching.example/v1", fetchImpl);

		await streamAnthropic(MODEL, CONTEXT, { client: rejecting, providerSessionState: states }).result();
		const other = await streamAnthropic(MODEL, CONTEXT, { client: caching, providerSessionState: states }).result();

		expect(other.stopReason).toBe("stop");
		expect(capture.bodies).toHaveLength(3);
		expect(countBreakpoints(capture.bodies[1])).toBe(0);
		expect(countBreakpoints(capture.bodies[2])).toBeGreaterThan(0);
	});

	it("still seeds the next turn through the same opaque injected client", async () => {
		const capture: Capture = { bodies: [], betaHeaders: [] };
		const states = new Map<string, ProviderSessionState>();
		const fetchImpl = createFetch(capture, ["reject", "ok", "ok"]);
		const client = createOpaqueClient("https://opaque-proxy.example/v1", fetchImpl);

		await streamAnthropic(MODEL, CONTEXT, { client, providerSessionState: states }).result();
		const second = await streamAnthropic(MODEL, CONTEXT, { client, providerSessionState: states }).result();

		expect(second.stopReason).toBe("stop");
		// Three requests, not four: the second turn's first attempt already
		// carried no breakpoint, so the proxy never refused it again.
		expect(capture.bodies).toHaveLength(3);
		expect(countBreakpoints(capture.bodies[2])).toBe(0);
	});

	it("keeps the rejection scoped to the rejecting endpoint and model", async () => {
		const capture: Capture = { bodies: [], betaHeaders: [] };
		const states = new Map<string, ProviderSessionState>();
		const fetchImpl = createFetch(capture, ["reject", "ok", "ok"]);
		const otherModel = buildModel({ ...MODEL, baseUrl: "https://gateway.example/v1" });

		await runTurn(fetchImpl, states);
		const other = await streamAnthropic(otherModel, CONTEXT, {
			apiKey: "sk-ant-api-test",
			cacheRetention: "long",
			providerSessionState: states,
			fetch: fetchImpl,
		}).result();

		expect(other.stopReason).toBe("stop");
		expect(countBreakpoints(capture.bodies[2])).toBeGreaterThan(0);
	});

	it("strips the OAuth identity block's default breakpoint on the replay", async () => {
		const capture: Capture = { bodies: [], betaHeaders: [] };
		const states = new Map<string, ProviderSessionState>();

		// OAuth injects the Claude Code identity system block, whose breakpoint
		// defaults to `ephemeral` when no lifetime is passed — an undefined
		// lifetime alone does not remove it.
		const message = await streamAnthropic(MODEL, CONTEXT, {
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			providerSessionState: states,
			fetch: createBreakpointRejectingFetch(capture),
		}).result();

		expect(message.stopReason).toBe("stop");
		expect(message.errorMessage).toBeUndefined();
		expect(capture.bodies).toHaveLength(2);
		expect(countBreakpoints(capture.bodies[1])).toBe(0);
		// The OAuth defaults advertise prompt-caching-scope unconditionally; a
		// replay carrying no breakpoint must not keep claiming caching the
		// endpoint just refused.
		expect(capture.betaHeaders[0]).toContain(PROMPT_CACHING_SCOPE_BETA);
		expect(capture.betaHeaders[1]).not.toContain(PROMPT_CACHING_SCOPE_BETA);
	});
});

describe("isCacheControlUnsupported", () => {
	it("detects a 400 refusing the cache_control field", () => {
		expect(
			isCacheControlUnsupported(
				makeStatusError(400, "400 messages.0.content.0.cache_control: Extra inputs are not permitted"),
			),
		).toBe(true);
	});

	it("ignores an empty-text-block 400 that names cache_control", () => {
		expect(
			isCacheControlUnsupported(makeStatusError(400, "400 cache_control is not permitted on an empty text block")),
		).toBe(false);
	});

	it("ignores a 429 that mentions cache_control", () => {
		expect(
			isCacheControlUnsupported(makeStatusError(429, "429 rate_limit_error: cache_control writes not permitted")),
		).toBe(false);
	});

	it("ignores a strict-tools 400 that does not name cache_control", () => {
		expect(
			isCacheControlUnsupported(
				makeStatusError(400, "400 invalid_request_error: tools.0.custom.strict: Extra inputs are not permitted"),
			),
		).toBe(false);
	});
});
