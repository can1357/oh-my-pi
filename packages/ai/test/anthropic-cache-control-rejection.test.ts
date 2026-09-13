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
import { buildAnthropicClientOptions, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessagesClient, type AnthropicMessagesClientLike } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import type { MessageCreateParams } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import type { AssistantMessage, Context, FetchImpl, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withOfficialAnthropicEndpoint } from "./helpers";

const EXTENDED_CACHE_TTL_BETA = "extended-cache-ttl-2025-04-11";
const PROMPT_CACHING_SCOPE_BETA = "prompt-caching-scope-2026-01-05";
/** Added by `compat.supportsPerMessageEffort`; forces a per-request override. */
const PER_MESSAGE_EFFORT_BETA = "mid-conversation-output-config-2026-07-01";
/** Caller-owned betas that have nothing to do with prompt caching. */
const CUSTOM_BETA = "custom-proxy-beta-2026-01-01";
const OTHER_CUSTOM_BETA = "custom-proxy-extra-2026-02-02";
const CLIENT_DEFAULT_BETA = "custom-client-default-2026-03-03";

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

/**
 * OAuth against a non-official endpoint whose compat opts into fingerprint
 * header overrides — the one shape where a caller's own `anthropic-beta` value
 * reaches the wire verbatim instead of being dropped as an enforced key.
 */
function overrideModel(headers: Record<string, string> = {}): Model<"anthropic-messages"> {
	return buildModel({
		...MODEL,
		provider: "custom-anthropic",
		baseUrl: "https://override-proxy.example/anthropic",
		headers,
		compat: { allowAnthropicHeaderOverrides: true },
	});
}

function runOverrideTurn(
	model: Model<"anthropic-messages">,
	capture: Capture,
	headers?: Record<string, string>,
): Promise<AssistantMessage> {
	return streamAnthropic(model, CONTEXT, {
		apiKey: "sk-ant-oat-test",
		isOAuth: true,
		headers,
		providerSessionState: new Map<string, ProviderSessionState>(),
		fetch: createFetch(capture, ["reject", "ok"]),
	}).result();
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

	it("drops a cache beta supplied through model.headers from the replay", async () => {
		const capture: Capture = { bodies: [], betaHeaders: [] };

		const message = await runOverrideTurn(
			overrideModel({ "anthropic-beta": `${EXTENDED_CACHE_TTL_BETA},${CUSTOM_BETA}` }),
			capture,
		);

		expect(message.stopReason).toBe("stop");
		expect(capture.betaHeaders[0]).toContain(EXTENDED_CACHE_TTL_BETA);
		expect(capture.betaHeaders[1]).not.toContain(EXTENDED_CACHE_TTL_BETA);
	});

	it("drops a cache beta supplied through options.headers from the replay", async () => {
		const capture: Capture = { bodies: [], betaHeaders: [] };

		const message = await runOverrideTurn(overrideModel(), capture, {
			// Mixed casing on purpose: HTTP header names are case-insensitive, so
			// a filter keyed on the exact lowercase spelling would miss this.
			"Anthropic-Beta": `${PROMPT_CACHING_SCOPE_BETA},${CUSTOM_BETA}`,
		});

		expect(message.stopReason).toBe("stop");
		expect(capture.betaHeaders[0]).toContain(PROMPT_CACHING_SCOPE_BETA);
		expect(capture.betaHeaders[1]).not.toContain(PROMPT_CACHING_SCOPE_BETA);
	});

	it("keeps the caller's other betas in the same header value on the replay", async () => {
		const capture: Capture = { bodies: [], betaHeaders: [] };

		await runOverrideTurn(
			overrideModel({
				"anthropic-beta": `${CUSTOM_BETA},${EXTENDED_CACHE_TTL_BETA},${OTHER_CUSTOM_BETA},${PROMPT_CACHING_SCOPE_BETA}`,
			}),
			capture,
		);

		// Exact value: only the two cache tokens leave, the rest keep their order,
		// and the list carries no empty entry or dangling separator.
		expect(capture.betaHeaders[1]).toBe(`${CUSTOM_BETA},${OTHER_CUSTOM_BETA}`);
	});

	it("keeps a caller-header cache beta out of an injected client's per-request override", async () => {
		const capture: Capture = { bodies: [], betaHeaders: [] };
		const fetchImpl = createFetch(capture, ["reject", "ok"]);
		// A control beta is what forces the provider to send a per-request
		// `anthropic-beta` at all for an injected client, and that override seeds
		// itself from the caller's own header value.
		const model = buildModel({ ...MODEL, compat: { supportsPerMessageEffort: true } });
		// Client-level betas the caller fixed at construction. The per-request
		// override replaces them wholesale, which is exactly why the provider may
		// never emit a blanket `anthropic-beta` it did not derive from the caller.
		const client = new AnthropicMessagesClient({
			apiKey: "sk-ant-api-test",
			baseURL: "https://injected.example/v1",
			fetch: fetchImpl,
			defaultHeaders: { "anthropic-beta": CLIENT_DEFAULT_BETA },
		});

		const message = await streamAnthropic(model, CONTEXT, {
			client,
			headers: { "anthropic-beta": `${EXTENDED_CACHE_TTL_BETA},${CUSTOM_BETA}` },
			providerSessionState: new Map<string, ProviderSessionState>(),
		}).result();

		expect(message.stopReason).toBe("stop");
		expect(capture.betaHeaders[0]).toContain(EXTENDED_CACHE_TTL_BETA);
		expect(capture.betaHeaders[1]).toBe(`${CUSTOM_BETA},${PER_MESSAGE_EFFORT_BETA}`);
	});

	it("cannot remove a cache beta baked into an injected client's own default headers", async () => {
		const capture: Capture = { bodies: [], betaHeaders: [] };
		const fetchImpl = createFetch(capture, ["reject", "ok"]);
		// No caller headers and no control beta, so the provider sends no
		// per-request override and the client's constructor-time headers are the
		// only beta source. Their value is unreadable from here, so the cache beta
		// survives the replay: dropping it is the owning caller's job.
		const client = new AnthropicMessagesClient({
			apiKey: "sk-ant-api-test",
			baseURL: "https://injected-defaults.example/v1",
			fetch: fetchImpl,
			defaultHeaders: { "anthropic-beta": `${CUSTOM_BETA},${EXTENDED_CACHE_TTL_BETA}` },
		});

		const message = await streamAnthropic(MODEL, CONTEXT, {
			client,
			providerSessionState: new Map<string, ProviderSessionState>(),
		}).result();

		expect(message.stopReason).toBe("stop");
		// The body still drops its breakpoints, so the replay can succeed.
		expect(countBreakpoints(capture.bodies[1])).toBe(0);
		// The client's header is passed through byte-for-byte: not rewritten, and
		// not wiped either — a blanket override would have cost the caller
		// `CUSTOM_BETA` as well.
		expect(capture.betaHeaders[1]).toBe(`${CUSTOM_BETA},${EXTENDED_CACHE_TTL_BETA}`);
	});

	it("strips a caller cache beta from the GitHub Copilot default headers", () => {
		// The Copilot branch builds its headers by merge alone — it has no
		// enforced-key filter, so a caller's `anthropic-beta` reaches the wire
		// verbatim on an ordinary API-key request.
		const options = buildAnthropicClientOptions({
			model: buildModel({
				...MODEL,
				provider: "github-copilot",
				baseUrl: "https://api.githubcopilot.com",
				headers: { "anthropic-beta": `${CUSTOM_BETA},${EXTENDED_CACHE_TTL_BETA}` },
			}),
			apiKey: "ghu_test_token_12345",
			stream: true,
			dropCacheControl: true,
		});

		expect(options.defaultHeaders["anthropic-beta"]).toBe(CUSTOM_BETA);
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

	it("detects a strict JSON decoder refusing cache_control as an unknown field", () => {
		// Go `DisallowUnknownFields` wording — a schema rejection with none of the
		// extra-input/not-permitted vocabulary.
		expect(isCacheControlUnsupported(makeStatusError(400, '400 json: unknown field "cache_control"'))).toBe(true);
	});

	it("detects an OpenAI-compatible unknown_parameter error code naming cache_control", () => {
		// The code arrives snake_cased, so word boundaries around a bare
		// `unknown` never fire on it.
		expect(
			isCacheControlUnsupported(makeStatusError(400, "400 unknown_parameter: messages[0].content[0].cache_control")),
		).toBe(true);
	});

	it("detects a validator reporting cache_control as not recognized", () => {
		expect(
			isCacheControlUnsupported(
				makeStatusError(400, "400 invalid_request_error: The property 'cache_control' was not recognized."),
			),
		).toBe(true);
	});

	it("detects a validator calling cache_control an invalid field for the endpoint", () => {
		expect(
			isCacheControlUnsupported(
				makeStatusError(400, "400 invalid_request_error: cache_control is not a valid field for this endpoint"),
			),
		).toBe(true);
	});

	it("keeps caching enabled when a 400 rejects the number of cache_control blocks", () => {
		// Anthropic's breakpoint cap: the endpoint does support prompt caching, so
		// disabling it for the rest of the session would be the wrong fallback.
		expect(
			isCacheControlUnsupported(
				makeStatusError(
					400,
					"400 invalid_request_error: messages: at most 4 blocks with cache_control may be provided",
				),
			),
		).toBe(false);
	});

	it("keeps caching enabled when a 400 rejects a cache_control value rather than the field", () => {
		// The field is accepted here; only the retention value is refused. Dropping
		// every breakpoint for the rest of the session is not the remedy, so the
		// unknown-member negations require a schema-member noun ("field",
		// "parameter", "key", …) and never fire on "not a valid value".
		expect(
			isCacheControlUnsupported(
				makeStatusError(
					400,
					`400 invalid_request_error: messages.0.content.0.cache_control.ttl: "2h" is not a valid value`,
				),
			),
		).toBe(false);
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
