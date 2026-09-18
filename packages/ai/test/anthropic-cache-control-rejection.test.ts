/**
 * Regression: an Anthropic-compatible endpoint that does not implement prompt
 * caching rejects the `cache_control` field itself with a 400. A 400 is
 * terminal for the provider retry gate and the replay path re-sends a
 * byte-identical body, so such an endpoint used to break the turn outright.
 *
 * The provider must replay the request without prompt-cache breakpoints,
 * remember the rejection for the rest of the session — scoped to the model and
 * to the endpoint the request reached, or to the injected client itself when it
 * publishes no endpoint — and stop advertising the extended-cache-ttl beta on
 * requests that carry no breakpoint at all.
 *
 * An endpoint that takes the field but refuses `ttl`/`scope` on it sends the
 * same 400, and no reading of the message separates the two. So the recovery is
 * a ladder keyed on what the failing request asked for, not on its wording:
 *
 *   1. The request carried `ttl` or `scope` → replay with every breakpoint
 *      intact, those options removed, and the betas that govern them withheld.
 *      Succeeding latches the narrow flag, so the session keeps 5m caching.
 *   2. Refused again, or the request carried no option at all → replay with no
 *      breakpoint. Succeeding latches `cacheControlUnsupported` as before.
 *
 * Both latches are written from the turn's success path, so a 400 that meant
 * something else costs one request rather than a session of lost caching.
 */
import { describe, expect, it } from "bun:test";
import { isCacheControlUnsupported } from "@oh-my-pi/pi-ai/error";
import {
	buildAnthropicClientOptions,
	clearAnthropicFastModeFallback,
	streamAnthropic,
} from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessagesClient, type AnthropicMessagesClientLike } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import type { CacheControlEphemeral, MessageCreateParams } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
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

/**
 * Three wordings for the same HTTP outcome. The first names the field's own
 * position, the second names a member under it, the third names that member in
 * prose — and each successive version of the text classifier this ladder
 * replaced drew its line somewhere between them. None of them is evidence about
 * which of the two things the endpoint actually refused, so all three have to
 * reach the ladder and be settled by replaying.
 */
const FIELD_SHAPED_REFUSAL = "messages.0.content.0.cache_control: Extra inputs are not permitted";
const PATH_SHAPED_OPTION_REFUSAL = `messages.0.content.0.cache_control.ttl: unsupported value "1h"`;
const PROSE_SHAPED_OPTION_REFUSAL = "unsupported ttl in cache_control";

/** Shape a caching-unaware proxy returns: a 400 naming what it refuses. */
function cacheControlRejectionResponse(message: string = FIELD_SHAPED_REFUSAL): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "invalid_request_error", message },
		}),
		{ status: 400, headers: { "Content-Type": "application/json" } },
	);
}

/**
 * Shape Anthropic returns for a model or account that cannot serve fast mode:
 * a 400 refusing the `speed` parameter itself.
 */
function fastModeRejectionResponse(): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "invalid_request_error",
				message: `'${MODEL.id}' does not support the \`speed\` parameter.`,
			},
		}),
		{ status: 400, headers: { "Content-Type": "application/json" } },
	);
}

/**
 * A terminal 400 that has nothing to do with prompt caching: no retry arm
 * claims it, so it fails the turn after the breakpoint-free replay went out.
 */
function unrelatedRejectionResponse(): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "invalid_request_error", message: "max_tokens: must be greater than 0" },
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

/** Records one request's body and beta header, and hands the body back. */
function recordRequest(capture: Capture, input: Request | URL | string, init: RequestInit | undefined) {
	const raw = init?.body;
	const text = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : String(raw ?? "{}");
	const body = JSON.parse(text) as MessageCreateParams;
	capture.bodies.push(body);
	const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
	capture.betaHeaders.push(headers.get("anthropic-beta") ?? "");
	return body;
}

function createFetch(capture: Capture, modes: Array<"reject" | "ok">): FetchImpl {
	return async (input, init) => {
		recordRequest(capture, input, init);
		const mode = modes[capture.bodies.length - 1];
		if (mode === undefined) throw new Error(`unexpected request #${capture.bodies.length}`);
		return mode === "reject" ? cacheControlRejectionResponse() : successResponse();
	};
}

/**
 * An endpoint that implements prompt caching but not the options on it: any
 * breakpoint carrying `ttl` or `scope` is refused, the same breakpoint without
 * them is accepted. It answers with the field-shaped 400 above, which is the
 * whole point — the bytes are the ones a field refusal sends, so only replaying
 * can tell the two apart.
 */
function createCacheOptionRejectingFetch(capture: Capture, message?: string): FetchImpl {
	return async (input, init) => {
		const body = recordRequest(capture, input, init);
		const refused = collectCacheControls(body).some(
			cacheControl => cacheControl.ttl !== undefined || cacheControl.scope !== undefined,
		);
		return refused ? cacheControlRejectionResponse(message) : successResponse();
	};
}

/**
 * A caching-unaware proxy modeled faithfully: every body that carries a
 * breakpoint anywhere is refused, so the turn can only complete once the
 * provider ships a body with none at all.
 *
 * `failBreakpointFreeAttempts` then fails that many breakpoint-free requests
 * for an unrelated reason, which is how a cache-motivated replay reaches a
 * turn that never completes.
 */
function createBreakpointRejectingFetch(capture: Capture, failBreakpointFreeAttempts = 0): FetchImpl {
	let failuresLeft = failBreakpointFreeAttempts;
	return async (input, init) => {
		const body = recordRequest(capture, input, init);
		if (countBreakpoints(body) > 0) return cacheControlRejectionResponse();
		if (failuresLeft > 0) {
			failuresLeft--;
			return unrelatedRejectionResponse();
		}
		return successResponse();
	};
}

/**
 * A proxy that refuses fast mode the way Anthropic refuses it for a model or
 * account without the entitlement: a 400 naming the `speed` parameter. With
 * `alsoRejectBreakpoints` it refuses prompt-cache breakpoints as well, so one
 * client can learn both fallbacks and a fast-mode re-arm has something to be
 * precise about.
 */
function createFastModeRejectingFetch(capture: Capture, alsoRejectBreakpoints = false): FetchImpl {
	return async (input, init) => {
		const body = recordRequest(capture, input, init);
		if (body.speed !== undefined) return fastModeRejectionResponse();
		if (alsoRejectBreakpoints && countBreakpoints(body) > 0) return cacheControlRejectionResponse();
		return successResponse();
	};
}

/** A turn that asks for fast mode through a caller-owned client. */
function runPriorityTurn(
	client: AnthropicMessagesClientLike,
	states: Map<string, ProviderSessionState>,
): Promise<AssistantMessage> {
	return streamAnthropic(MODEL, CONTEXT, {
		client,
		serviceTier: "priority",
		providerSessionState: states,
	}).result();
}

/**
 * The default request shape: `short` retention, so the breakpoints carry no
 * `ttl` and no `scope`. A `cache_control` refusal on such a request cannot be
 * about a nested option, so the ladder has exactly one rung and every row built
 * on this runner is reading the field-level fallback.
 */
function runTurn(
	fetchImpl: FetchImpl,
	states: Map<string, ProviderSessionState>,
	model: Model<"anthropic-messages"> = MODEL,
): Promise<AssistantMessage> {
	return streamAnthropic(model, CONTEXT, {
		apiKey: "sk-ant-api-test",
		cacheRetention: "short",
		providerSessionState: states,
		fetch: fetchImpl,
	}).result();
}

/**
 * The same turn asking for 1h retention, which is the only API-key path that
 * puts `ttl` on a breakpoint and the extended-cache-ttl beta on the header. A
 * refusal here gets the retention rung before the field rung.
 */
function runLongTurn(fetchImpl: FetchImpl, states: Map<string, ProviderSessionState>): Promise<AssistantMessage> {
	return streamAnthropic(MODEL, CONTEXT, {
		apiKey: "sk-ant-api-test",
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
function collectCacheControls(body: MessageCreateParams): CacheControlEphemeral[] {
	// `type` is carried only so this stays a structural match for the content
	// blocks that declare no `cache_control` at all (`fallback`), which a
	// single-optional-property shape rejects outright as a weak type.
	const holders: Array<{ type?: string; cache_control?: CacheControlEphemeral | null }> = [];
	for (const block of body.system ?? []) {
		if (typeof block !== "string") holders.push(block);
	}
	for (const tool of body.tools ?? []) holders.push(tool);
	for (const message of body.messages ?? []) {
		if (Array.isArray(message.content)) holders.push(...message.content);
	}
	const found: CacheControlEphemeral[] = [];
	for (const holder of holders) {
		if (holder.cache_control != null) found.push(holder.cache_control);
	}
	return found;
}

function countBreakpoints(body: MessageCreateParams): number {
	return collectCacheControls(body).length;
}

/**
 * The distinct `ttl` values on the wire, with an omitted `ttl` spelled
 * `"default"` rather than left `undefined`: `toEqual` treats `[]` and
 * `[undefined]` as equal, which would let a breakpoint-free body satisfy an
 * assertion about a breakpoint that merely dropped its retention.
 */
function breakpointTtls(body: MessageCreateParams): string[] {
	return [...new Set(collectCacheControls(body).map(cacheControl => cacheControl.ttl ?? "default"))];
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
		// The request asked for neither `ttl` nor `scope`, so a nested refusal was
		// impossible and the ladder has no retention rung to spend: two requests,
		// not three. A rung gated on the wording instead of on the request state
		// would have burned one here on every such endpoint.
		expect(breakpointTtls(capture.bodies[0])).toEqual(["default"]);
		expect(capture.bodies).toHaveLength(2);
		expect(countBreakpoints(capture.bodies[0])).toBeGreaterThan(0);
		expect(countBreakpoints(capture.bodies[1])).toBe(0);
		expect(message.disabledFeatures).toContain("prompt-cache");
		expect(message.disabledFeatures).not.toContain("prompt-cache-retention");
	});

	// One row per wording: the shapes used to take opposite branches — the
	// path-shaped one was vetoed as nested, the field-shaped one drove the
	// breakpoint-free replay, and the prose one flipped sides between review
	// rounds. The outcome is now the endpoint's answer rather than the message's,
	// so all three converge here.
	it.each([
		["a field-shaped refusal", FIELD_SHAPED_REFUSAL],
		["a path-shaped refusal naming the option", PATH_SHAPED_OPTION_REFUSAL],
		["a prose refusal naming the option first", PROSE_SHAPED_OPTION_REFUSAL],
	])("keeps 5m caching when an endpoint refusing only the options answers with %s", async (_shape, message) => {
		const capture: Capture = { bodies: [], betaHeaders: [] };
		const states = new Map<string, ProviderSessionState>();
		const fetchImpl = createCacheOptionRejectingFetch(capture, message);

		const first = await runLongTurn(fetchImpl, states);
		const second = await runLongTurn(fetchImpl, states);

		expect(first.stopReason).toBe("stop");
		expect(second.stopReason).toBe("stop");
		// Three requests: 1h refused, the same breakpoints without `ttl` accepted,
		// and a second turn that never had to pay the refusal again.
		expect(capture.bodies).toHaveLength(3);
		expect(breakpointTtls(capture.bodies[0])).toEqual(["1h"]);
		// The rung that carried the turn kept every breakpoint. Reading this 400 as
		// a field refusal would have shipped a breakpoint-free body instead and
		// latched caching off for the session.
		expect(countBreakpoints(capture.bodies[1])).toBe(countBreakpoints(capture.bodies[0]));
		expect(breakpointTtls(capture.bodies[1])).toEqual(["default"]);
		expect(capture.betaHeaders[1]).not.toContain(EXTENDED_CACHE_TTL_BETA);
		// The narrow latch, not the field one: the next turn's first attempt still
		// caches, and still asks for no retention it has been refused.
		expect(countBreakpoints(capture.bodies[2])).toBe(countBreakpoints(capture.bodies[0]));
		expect(breakpointTtls(capture.bodies[2])).toEqual(["default"]);
		// What a consumer is told. `prompt-cache` would be a lie here — the
		// breakpoints went out and the endpoint is caching against them.
		expect(first.disabledFeatures).toContain("prompt-cache-retention");
		expect(first.disabledFeatures).not.toContain("prompt-cache");
		expect(second.disabledFeatures).toContain("prompt-cache-retention");
	});

	it("strips every breakpoint when the retention rung is refused the same way", async () => {
		const capture: Capture = { bodies: [], betaHeaders: [] };
		const states = new Map<string, ProviderSessionState>();
		const fetchImpl = createBreakpointRejectingFetch(capture);

		const first = await runLongTurn(fetchImpl, states);
		const second = await runLongTurn(fetchImpl, states);

		expect(first.stopReason).toBe("stop");
		expect(second.stopReason).toBe("stop");
		// A 1h request against an endpoint with no prompt caching at all: the
		// retention rung goes out first and is refused identically, so the ladder
		// falls through to the breakpoint-free replay rather than failing the turn.
		expect(breakpointTtls(capture.bodies[0])).toEqual(["1h"]);
		expect(countBreakpoints(capture.bodies[1])).toBeGreaterThan(0);
		expect(breakpointTtls(capture.bodies[1])).toEqual(["default"]);
		expect(countBreakpoints(capture.bodies[2])).toBe(0);
		// The field latch won, so the session stops offering breakpoints — the
		// narrow one would have put them back on this attempt.
		expect(capture.bodies).toHaveLength(4);
		expect(countBreakpoints(capture.bodies[3])).toBe(0);
		expect(first.disabledFeatures).toContain("prompt-cache");
		expect(first.disabledFeatures).not.toContain("prompt-cache-retention");
	});

	it("asks for retention again after the session-close sweep", async () => {
		const capture: Capture = { bodies: [], betaHeaders: [] };
		const states = new Map<string, ProviderSessionState>();
		const fetchImpl = createCacheOptionRejectingFetch(capture);

		await runLongTurn(fetchImpl, states);
		// What `/new` does. The narrow flag has to reset with the others, or a
		// refusal learned before the sweep keeps 1h off for the process lifetime.
		for (const state of states.values()) state.close();
		const after = await runLongTurn(fetchImpl, states);

		expect(after.stopReason).toBe("stop");
		expect(capture.bodies).toHaveLength(4);
		expect(breakpointTtls(capture.bodies[2])).toEqual(["1h"]);
		expect(breakpointTtls(capture.bodies[3])).toEqual(["default"]);
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

	it("leaves the rejection unlearned when the breakpoint-free replay never completes", async () => {
		const capture: Capture = { bodies: [], betaHeaders: [] };
		const states = new Map<string, ProviderSessionState>();
		// The refusal is parsed, the replay goes out — and then dies for a reason
		// that says nothing about `cache_control`.
		const fetchImpl = createBreakpointRejectingFetch(capture, 1);

		const failed = await runTurn(fetchImpl, states);
		const next = await runTurn(fetchImpl, states);

		expect(failed.stopReason).toBe("error");
		expect(next.stopReason).toBe("stop");
		// Four requests: the next turn still offered breakpoints, because nothing
		// had yet shown the endpoint's refusal to be real. `isCacheControlUnsupported`
		// classifies a free-text 400, and a misparse that is never confirmed by a
		// completed turn must cost one request, not a session of suppressed
		// caching. Learning from the parse alone makes the third request
		// breakpoint-free and there is no fourth.
		expect(capture.bodies).toHaveLength(4);
		expect(countBreakpoints(capture.bodies[2])).toBeGreaterThan(0);
		expect(countBreakpoints(capture.bodies[3])).toBe(0);
		// And the turn that did complete still reports the feature it gave up.
		expect(next.disabledFeatures).toContain("prompt-cache");
	});

	it("stops advertising the extended-cache-ttl beta from the first retry onward", async () => {
		const capture: Capture = { bodies: [], betaHeaders: [] };
		const states = new Map<string, ProviderSessionState>();
		const fetchImpl = createBreakpointRejectingFetch(capture);

		await runLongTurn(fetchImpl, states);
		await runLongTurn(fetchImpl, states);

		expect(capture.betaHeaders[0]).toContain(EXTENDED_CACHE_TTL_BETA);
		// The immediate retry, not just the next turn: the client's default
		// headers must be rebuilt alongside the body. Both rungs qualify — the
		// retention rung keeps its breakpoints but no longer asks for 1h, and a
		// header still claiming the beta would contradict the body it rides on.
		expect(capture.bodies).toHaveLength(4);
		expect(capture.betaHeaders[1]).not.toContain(EXTENDED_CACHE_TTL_BETA);
		expect(capture.betaHeaders[2]).not.toContain(EXTENDED_CACHE_TTL_BETA);
		expect(capture.betaHeaders[3]).not.toContain(EXTENDED_CACHE_TTL_BETA);
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

	it("keeps one opaque injected client's rejection out of a second session's state", async () => {
		const capture: Capture = { bodies: [], betaHeaders: [] };
		const first = new Map<string, ProviderSessionState>();
		const second = new Map<string, ProviderSessionState>();
		const fetchImpl = createBreakpointRejectingFetch(capture);
		// One transport built once and handed to two agents is the ordinary SDK
		// embedding shape: the client is shared, the session state is not. Holding
		// the state against the client alone would let the second agent inherit
		// everything the first learned, with no way for its own map to say so.
		const shared = createOpaqueClient("https://opaque-shared.example/v1", fetchImpl);

		await streamAnthropic(MODEL, CONTEXT, { client: shared, providerSessionState: first }).result();
		const other = await streamAnthropic(MODEL, CONTEXT, { client: shared, providerSessionState: second }).result();

		expect(other.stopReason).toBe("stop");
		// Two attempts per session, not one for the second: it had to take the
		// refusal itself rather than start out suppressed by an unrelated session.
		expect(capture.bodies).toHaveLength(4);
		expect(countBreakpoints(capture.bodies[2])).toBeGreaterThan(0);
		expect(countBreakpoints(capture.bodies[3])).toBe(0);
	});

	it("keeps a shared opaque injected client sticky in the session that learned the rejection", async () => {
		const capture: Capture = { bodies: [], betaHeaders: [] };
		const first = new Map<string, ProviderSessionState>();
		const second = new Map<string, ProviderSessionState>();
		const fetchImpl = createBreakpointRejectingFetch(capture);
		const shared = createOpaqueClient("https://opaque-shared.example/v1", fetchImpl);

		await streamAnthropic(MODEL, CONTEXT, { client: shared, providerSessionState: first }).result();
		await streamAnthropic(MODEL, CONTEXT, { client: shared, providerSessionState: second }).result();
		// Back to the first session: separating the two sessions must not have cost
		// either of them its own learning, which a per-request state would.
		const again = await streamAnthropic(MODEL, CONTEXT, { client: shared, providerSessionState: first }).result();

		expect(again.stopReason).toBe("stop");
		// Five attempts: two per session to learn, then one — already breakpoint
		// free — for the first session's second turn.
		expect(capture.bodies).toHaveLength(5);
		expect(countBreakpoints(capture.bodies[4])).toBe(0);
		// Neither session paid for that with more than the single anchor entry,
		// and neither could read the other's through it.
		expect(first.size).toBe(1);
		expect(second.size).toBe(1);
	});

	it("keeps the caller's session map at one entry however many opaque clients learn a rejection", async () => {
		const capture: Capture = { bodies: [], betaHeaders: [] };
		const states = new Map<string, ProviderSessionState>();
		const fetchImpl = createBreakpointRejectingFetch(capture);

		// Three wrappers in a row is what an SDK that rebuilds its client per
		// request produces. Each is isolated by the store the anchor hands it, so
		// the caller's map holds that one anchor and never an entry per client —
		// one of those would outlive the client that owns it and only be released
		// when the whole session closes.
		for (const baseURL of [
			"https://opaque-a.example/v1",
			"https://opaque-b.example/v1",
			"https://opaque-c.example/v1",
		]) {
			const message = await streamAnthropic(MODEL, CONTEXT, {
				client: createOpaqueClient(baseURL, fetchImpl),
				providerSessionState: states,
			}).result();
			expect(message.stopReason).toBe("stop");
			expect(states.size).toBe(1);
		}

		// Two requests per client: every one of them took the rejection and
		// learned from it, so the flat count is isolation without per-client
		// retention rather than state that was never created.
		expect(capture.bodies).toHaveLength(6);
	});

	it("lets the session-close sweep reset a still-live opaque injected client", async () => {
		const capture: Capture = { bodies: [], betaHeaders: [] };
		const states = new Map<string, ProviderSessionState>();
		const fetchImpl = createBreakpointRejectingFetch(capture);
		const client = createOpaqueClient("https://opaque-proxy.example/v1", fetchImpl);

		await streamAnthropic(MODEL, CONTEXT, { client, providerSessionState: states }).result();
		// What `/new` does to a live session: close every provider state the map
		// holds. The client object outlives that, so the sweep is the only thing
		// that can return it to an unsuppressed first attempt.
		for (const state of states.values()) state.close();

		const after = await streamAnthropic(MODEL, CONTEXT, { client, providerSessionState: states }).result();

		expect(after.stopReason).toBe("stop");
		// Four attempts, not three: the turn after the sweep took the rejection
		// again rather than starting out breakpoint-free.
		expect(capture.bodies).toHaveLength(4);
		expect(countBreakpoints(capture.bodies[2])).toBeGreaterThan(0);
		expect(countBreakpoints(capture.bodies[3])).toBe(0);
		// And the swept anchor was reusable, not stranded closed: the relearning
		// above went back through it rather than into a second entry.
		expect(states.size).toBe(1);
	});

	it("mints no endpoint-keyed entry for an opaque injected client", async () => {
		const capture: Capture = { bodies: [], betaHeaders: [] };
		const states = new Map<string, ProviderSessionState>();
		const fetchImpl = createFetch(capture, ["ok", "ok"]);

		const proxied = await streamAnthropic(MODEL, CONTEXT, {
			client: createOpaqueClient("https://opaque-proxy.example/v1", fetchImpl),
			providerSessionState: states,
		}).result();

		expect(proxied.stopReason).toBe("stop");
		// The anchor, and nothing claiming an endpoint. A synthetic
		// `anthropic-messages:` key would be swept by
		// `clearAnthropicFastModeFallback` as a per-endpoint state, and would let
		// an unknowable proxy answer for whatever endpoint it forged.
		expect(states.size).toBe(1);
		expect([...states.keys()].filter(key => key.startsWith("anthropic-messages"))).toEqual([]);
		// The same map still takes an endpoint entry for a request it can name,
		// so the assertions above read a live map rather than one nothing writes to.
		await runTurn(fetchImpl, states);
		expect(states.size).toBe(2);
		expect([...states.keys()].filter(key => key.startsWith("anthropic-messages:"))).toHaveLength(1);
	});

	it("holds nothing for an opaque injected client when the caller passes no session map", async () => {
		const capture: Capture = { bodies: [], betaHeaders: [] };
		const fetchImpl = createBreakpointRejectingFetch(capture);
		const client = createOpaqueClient("https://opaque-proxy.example/v1", fetchImpl);

		await streamAnthropic(MODEL, CONTEXT, { client }).result();
		const second = await streamAnthropic(MODEL, CONTEXT, { client }).result();

		expect(second.stopReason).toBe("stop");
		// Four attempts: a caller with no map opted out of session state, and an
		// injected client does not opt them back in through a store of its own.
		expect(capture.bodies).toHaveLength(4);
		expect(countBreakpoints(capture.bodies[2])).toBeGreaterThan(0);
	});

	it("keeps the rejection scoped to the rejecting endpoint and model", async () => {
		const capture: Capture = { bodies: [], betaHeaders: [] };
		const states = new Map<string, ProviderSessionState>();
		const fetchImpl = createFetch(capture, ["reject", "ok", "ok"]);
		const otherModel = buildModel({ ...MODEL, baseUrl: "https://gateway.example/v1" });

		await runTurn(fetchImpl, states);
		const other = await runTurn(fetchImpl, states, otherModel);

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
		// Three rungs, because OAuth on an official endpoint defaults to 1h
		// retention: the request carried `ttl`, so the retention rung goes first
		// and the identity block survives it. Only the rung below it drops the
		// breakpoint the block defaults to.
		expect(capture.bodies).toHaveLength(3);
		expect(breakpointTtls(capture.bodies[0])).toEqual(["1h"]);
		expect(countBreakpoints(capture.bodies[1])).toBeGreaterThan(0);
		expect(countBreakpoints(capture.bodies[2])).toBe(0);
		// The OAuth defaults advertise prompt-caching-scope unconditionally; that
		// beta governs `scope`, so neither rung may keep claiming it.
		expect(capture.betaHeaders[0]).toContain(PROMPT_CACHING_SCOPE_BETA);
		expect(capture.betaHeaders[1]).not.toContain(PROMPT_CACHING_SCOPE_BETA);
		expect(capture.betaHeaders[2]).not.toContain(PROMPT_CACHING_SCOPE_BETA);
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
			dropPromptCacheBetas: true,
		});

		expect(options.defaultHeaders["anthropic-beta"]).toBe(CUSTOM_BETA);
	});
});

/**
 * Residual of the opaque-client anchor, reported on review: such a client's
 * state lives in a `WeakMap` that `clearAnthropicFastModeFallback` cannot walk,
 * so a `/fast on` re-arm used to leave the client silently demoted for the rest
 * of the session — the user toggled it and nothing happened. The anchor now
 * carries a re-arm generation the state picks up on its next request.
 *
 * The endpoint-keyed side of the same re-arm is covered by
 * `anthropic-fast-mode.test.ts` ("flips fastModeDisabled back to false without
 * touching unrelated flags", plus the no-op-without-an-entry row that pins the
 * sweep to materializing nothing) and by `fast-mode-scope.test.ts` ("keeps
 * Anthropic priority enabled while an exact-model provider fallback makes it
 * inactive").
 */
describe("Anthropic fast-mode re-arm through an opaque injected client", () => {
	it("asks for fast mode again on the next request after a re-arm", async () => {
		const capture: Capture = { bodies: [], betaHeaders: [] };
		const states = new Map<string, ProviderSessionState>();
		const client = createOpaqueClient("https://opaque-fast.example/v1", createFastModeRejectingFetch(capture));

		await runPriorityTurn(client, states);
		// `/fast on` after the turn above auto-disabled it. The sweep cannot reach
		// this client's state, so only something the next request consults can
		// carry the toggle through to the wire.
		clearAnthropicFastModeFallback(states);
		const after = await runPriorityTurn(client, states);

		expect(after.stopReason).toBe("stop");
		// First turn: asked for fast mode, was refused, replayed without `speed`.
		expect(capture.bodies[0].speed).toBe("fast");
		expect(capture.bodies[1].speed).toBeUndefined();
		// Second turn asks again rather than honoring a fallback the user revoked.
		expect(capture.bodies[2].speed).toBe("fast");
		expect(capture.bodies).toHaveLength(4);
	});

	it("re-arms fast mode without clearing the same client's cache_control learning", async () => {
		const capture: Capture = { bodies: [], betaHeaders: [] };
		const states = new Map<string, ProviderSessionState>();
		const client = createOpaqueClient(
			"https://opaque-fast-and-cache.example/v1",
			createFastModeRejectingFetch(capture, true),
		);

		// Three attempts to learn both fallbacks: `speed` refused, then the
		// breakpoints, then a request the proxy accepts.
		await runPriorityTurn(client, states);
		expect(capture.bodies).toHaveLength(3);

		clearAnthropicFastModeFallback(states);
		const after = await runPriorityTurn(client, states);

		expect(after.stopReason).toBe("stop");
		// The re-arm reached `fastModeDisabled` …
		expect(capture.bodies[3].speed).toBe("fast");
		// … and nothing else. Had it discarded the client's store wholesale, this
		// first attempt would carry breakpoints again and pay a second
		// `cache_control` 400 as the price of a fast-mode toggle.
		expect(countBreakpoints(capture.bodies[3])).toBe(0);
		// Which is what keeps the second turn at two attempts: `speed` refused
		// once more, then the replay succeeds.
		expect(capture.bodies).toHaveLength(5);
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

	it("detects an OpenAI-compatible validator calling cache_control an invalid parameter", () => {
		// The adjective carries the refusal with no negation anywhere in the
		// message, which is the shape every OpenAI-compatible `Invalid
		// parameter: …` 400 has.
		expect(
			isCacheControlUnsupported(makeStatusError(400, "400 invalid_request_error: Invalid parameter: cache_control")),
		).toBe(true);
	});

	// Snake_cased error codes, which the prose gate structurally cannot see: `_`
	// is a word character, so `\bunsupported\b` never fires on
	// `unsupported_parameter` and `\bunrecognized\b` never fires on
	// `unrecognized_keys`. Each row is a different emitter and a different
	// adjective/noun branch of the widened pattern.
	it.each([
		["OpenAI-compatible invalid_parameter", "invalid_parameter: messages[0].content[0].cache_control"],
		["OpenAI-compatible unsupported_parameter", "unsupported_parameter: messages[0].content[0].cache_control"],
		// A strict Zod object rejects extra keys with this code — the same 400
		// this repo's auth-broker returned when an MCP credential carried
		// provider extension fields.
		["a strict Zod schema's unrecognized_keys", `unrecognized_keys: ["cache_control"]`],
		// gRPC/Connect's canonical code, which is what a proxy fronted by a
		// Connect gateway returns for a field its schema has no slot for.
		["a Connect gateway's invalid_argument", "invalid_argument: messages[0].content[0].cache_control"],
		// protojson, so any Google-gateway-fronted deployment: the repo has this
		// exact 400 captured for `store` and `propertyNames`.
		["protojson's unknown name", `Invalid JSON payload received. Unknown name "cache_control": Cannot find field.`],
	])("detects %s naming cache_control", (_emitter, message) => {
		expect(isCacheControlUnsupported(makeStatusError(400, `400 ${message}`))).toBe(true);
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

	// Inverse of the rows this file used to carry for the member distinction: a
	// 400 naming a member under or before the field is no longer vetoed, because
	// no reading of those bytes says whether the field or the option was refused.
	// Admitting them is what lets the ladder ask the endpoint; re-narrowing the
	// pattern would strand a real option refusal on a terminal 400 again.
	it.each([
		["names a member under the field", PATH_SHAPED_OPTION_REFUSAL],
		["names a member before the field in prose", PROSE_SHAPED_OPTION_REFUSAL],
		["names a member under the field in a JSON Pointer", `{"pointer":"/messages/0/cache_control/scope"}`],
	])("classifies a 400 that %s", (_shape, message) => {
		expect(isCacheControlUnsupported(makeStatusError(400, `400 unrecognized member: ${message}`))).toBe(true);
	});

	it("keeps caching enabled when a 400 refuses a cache_control value while naming the field itself", () => {
		// No trailing segment to key on: the named member is the field, and only
		// its value is refused. Every member refusal is anchored to a
		// schema-member noun ("field", "parameter", "key", …) and `value` is
		// deliberately not one of them, so "not a valid value" never reaches the
		// fallback.
		expect(
			isCacheControlUnsupported(
				makeStatusError(400, `400 invalid_request_error: cache_control: "2h" is not a valid value`),
			),
		).toBe(false);
	});

	it("keeps caching enabled when an error code refuses a cache_control value", () => {
		// Same contract in code form, and the bound on the widened adjective
		// vocabulary: `invalid_value` is one joiner away from a noun too, so only
		// `value`'s absence from the noun class keeps it out. `invalid_request_error`
		// prefixing the message is likewise inert — `request` is not a member noun.
		expect(
			isCacheControlUnsupported(
				makeStatusError(400, "400 invalid_request_error: invalid_value: messages[0].content[0].cache_control"),
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
