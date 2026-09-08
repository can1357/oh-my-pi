import { randomUUID } from "node:crypto";
import { CODEX_BASE_URL, OPENAI_HEADERS } from "@oh-my-pi/pi-catalog/wire/codex";
import { resolveApiKeyOnce, type ApiKey } from "../auth-retry";
import {
	attach,
	AuthGatewayError,
	classify,
	classifyMessage,
	ConfigurationError,
	create,
	Flag,
	OpenAIHttpError,
} from "../error";
import type { Api, Context, FetchImpl, Model, OptionsForApi, StreamOptions } from "../types";
import { getHeaderCaseInsensitive } from "../utils";
import { AssistantMessageEventStream } from "../utils/event-stream";
import type { CapturedHttpErrorResponse } from "../utils/http-inspector";
import { captureOpenAIHttpError } from "../utils/openai-http";
import { transportFetch } from "../utils/transport-fetch";
import type { AnthropicOptions } from "./anthropic";
import type { OpenAICodexResponsesOptions } from "./openai-codex-responses";
import { streamAnthropic, streamOpenAICodexResponses } from "./register-builtins";

const MAX_ATTEMPTS = 3;
const PRE_EXECUTION_REFUSALS = new Set([401, 403, 408, 409, 429]);
const PROVIDER_URLS = {
	anthropic: "https://api.anthropic.com/v1/messages?beta=true",
	"openai-codex": `${CODEX_BASE_URL}/codex/responses`,
} as const;

// No arbitrary header prefix is trusted. In particular, authorization, API keys,
// cookies, account/residency claims, destination and proxy headers are absent.
const SAFE_HEADERS: Record<string, true> = {
	accept: true,
	"accept-encoding": true,
	"content-type": true,
	"content-encoding": true,
	"user-agent": true,
	"anthropic-version": true,
	"anthropic-beta": true,
	"anthropic-dangerous-direct-browser-access": true,
	"x-app": true,
	"x-claude-code-session-id": true,
	"x-client-request-id": true,
	"x-stainless-arch": true,
	"x-stainless-lang": true,
	"x-stainless-os": true,
	"x-stainless-package-version": true,
	"x-stainless-retry-count": true,
	"x-stainless-runtime": true,
	"x-stainless-runtime-version": true,
	"x-stainless-timeout": true,
	"x-codex-turn-state": true,
	"x-models-etag": true,
	[OPENAI_HEADERS.BETA.toLowerCase()]: true,
	[OPENAI_HEADERS.CODEX_BETA_FEATURES]: true,
	[OPENAI_HEADERS.ORIGINATOR]: true,
	[OPENAI_HEADERS.VERSION]: true,
	[OPENAI_HEADERS.SESSION_ID]: true,
	[OPENAI_HEADERS.CONVERSATION_ID]: true,
	[OPENAI_HEADERS.SCOPED_SESSION_ID]: true,
	[OPENAI_HEADERS.THREAD_ID]: true,
	[OPENAI_HEADERS.WINDOW_ID]: true,
	[OPENAI_HEADERS.TURN_METADATA]: true,
	[OPENAI_HEADERS.PARENT_THREAD_ID]: true,
	[OPENAI_HEADERS.SUBAGENT]: true,
	[OPENAI_HEADERS.RESPONSES_LITE]: true,
	[OPENAI_HEADERS.ATTESTATION]: true,
	[OPENAI_HEADERS.ROUTING_HINT]: true,
};

/** The complete gateway error envelope is retained, not flattened into an assistant error string. */
export class ProviderWireError extends AuthGatewayError {
	readonly captured: CapturedHttpErrorResponse;

	constructor(captured: CapturedHttpErrorResponse) {
		const { detail, code } = OpenAIHttpError.parseEnvelope(captured.bodyJson, captured.bodyText);
		super(detail ?? `auth-gateway ${captured.status}`, captured.status, captured.headers, code);
		this.name = "ProviderWireError";
		this.captured = captured;
		attach(this, create(classify(this), Flag.NoRetry));
	}
}

function safeHeaders(source: RequestInit["headers"]): Headers {
	const safe = new Headers();
	for (const [name, value] of new Headers(source)) {
		if (SAFE_HEADERS[name] === true) safe.set(name, value);
	}
	return safe;
}

function forbidReplay(error: unknown): unknown {
	const target =
		error !== null && typeof error === "object" && Object.isExtensible(error)
			? error
			: new Error(error instanceof Error ? error.message : String(error), { cause: error });
	return attach(target, create(classify(error), Flag.NoRetry));
}

/**
 * Route already-serialized provider requests to the byte-pass gateway. The
 * allowlisted provider URL is a codec invariant, never a caller destination.
 * Retries reuse the same client-owned bytes only after a known refusal.
 */
export function createProviderWireFetch(model: Model<Api>, options: StreamOptions): FetchImpl {
	const provider = model.provider;
	if (
		!(
			(provider === "anthropic" && model.api === "anthropic-messages") ||
			(provider === "openai-codex" && model.api === "openai-codex-responses")
		)
	) {
		throw new ConfigurationError("provider-wire requires the Anthropic or OpenAI Codex native API");
	}
	if (!model.baseUrl) throw new ConfigurationError("provider-wire requires a gateway baseUrl");
	const gateway = new URL(model.baseUrl);
	const gatewayHostname = gateway.hostname.replace(/\.$/, "");
	if (
		(gateway.protocol !== "https:" && gateway.protocol !== "http:") ||
		gateway.username ||
		gateway.password ||
		gateway.search ||
		gateway.hash ||
		gatewayHostname === "api.anthropic.com" ||
		gatewayHostname === "chatgpt.com"
	) {
		throw new ConfigurationError(
			"provider-wire requires an HTTP(S) gateway URL, not a provider or credential-bearing URL",
		);
	}
	const gatewayUrl = `${gateway.href.replace(/\/+$/, "")}/v1/provider-wire/${provider}`;
	if (!/^[\x21-\x7e]{1,256}$/.test(model.id)) {
		throw new ConfigurationError("provider-wire model id must contain 1-256 visible ASCII bytes");
	}
	const sessionId = options.sessionId || options.promptCacheKey;
	if (sessionId !== undefined && Buffer.byteLength(sessionId, "utf8") > 1000) {
		throw new ConfigurationError("provider-wire session id must not exceed 1000 bytes");
	}
	if (!options.apiKey) throw new ConfigurationError("provider-wire requires a gateway bearer");
	const bearer = options.apiKey;
	const expectedUrl = PROVIDER_URLS[provider];
	// Explicitly avoid Anthropic's direct-provider cowork fetch default. Network
	// policy/debug still comes from the shared transport, at the gateway URL.
	const gatewayFetch = transportFetch(model, options.fetch ?? globalThis.fetch);

	return async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		if (url !== expectedUrl || method !== "POST") {
			throw new ConfigurationError("provider-wire refused a non-canonical provider request URL or method");
		}
		// Both stock codecs serialize into a string or byte array. Do not buffer
		// an arbitrary stream/Request, or reserialize a body to make it replayable.
		const body = init?.body;
		if (typeof body !== "string" && !(body instanceof Uint8Array)) {
			throw new ConfigurationError("provider-wire requires a serialized provider request body");
		}
		const headers = safeHeaders(init?.headers ?? (input instanceof Request ? input.headers : undefined));
		headers.set("authorization", `Bearer ${bearer}`);
		headers.set("x-omp-provider-wire-version", "1");
		headers.set("x-omp-model-id", model.id);
		if (sessionId !== undefined) headers.set("x-omp-session-id", sessionId);
		for (const [name, value] of [
			["x-omp-first-event-timeout-ms", options.streamFirstEventTimeoutMs],
			["x-omp-idle-timeout-ms", options.streamIdleTimeoutMs],
		] as const) {
			if (value === undefined || value === 0) continue;
			if (!Number.isSafeInteger(value) || value < 0) {
				throw new ConfigurationError(`${name} must be a positive safe integer`);
			}
			headers.set(name, String(value));
		}
		const providerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
		const signal =
			providerSignal && options.signal && providerSignal !== options.signal
				? AbortSignal.any([providerSignal, options.signal])
				: (providerSignal ?? options.signal);
		// Bun's timeout:false keeps the codec's own first/idle watchdogs in charge.
		const requestInit = {
			method: "POST",
			headers,
			body,
			signal,
			redirect: "error",
			credentials: "omit",
			timeout: false,
		} satisfies RequestInit & { timeout: false };
		for (let attempt = 1; ; attempt++) {
			signal?.throwIfAborted();
			// Never follow a redirect with gateway authorization, or inherit a
			// provider Request's cookies, TLS/proxy settings, Host, or destination.
			const response = await gatewayFetch(gatewayUrl, requestInit);
			if (response.ok) return response;
			const refused =
				(PRE_EXECUTION_REFUSALS.has(response.status) &&
					(response.headers.get("x-s99-upstream") === "provider" ||
						response.headers.get("x-s99-execution") === "none")) ||
				(response.status === 503 && response.headers.get("x-s99-execution") === "none");
			if (!refused || attempt >= MAX_ATTEMPTS) {
				const error = await captureOpenAIHttpError(response);
				signal?.throwIfAborted();
				throw new ProviderWireError(error.captured);
			}
			await response.body?.cancel();
			// No catch/retry around fetch: a timeout or connection loss cannot
			// establish whether the provider executed this request.
		}
	};
}

/** Run the stock provider codecs locally; only auth injection and bytes cross the gateway. */
export function streamProviderWire<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: OptionsForApi<TApi>,
	gatewayKey: ApiKey | undefined = options?.apiKey,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();
	void (async () => {
		try {
			options?.signal?.throwIfAborted();
			if (options && "client" in options && options.client !== undefined) {
				throw new ConfigurationError("provider-wire requires the native provider client; customize fetch instead");
			}
			if (options?.anthropicCacheRefreshRequest) {
				throw new ConfigurationError("provider-wire only supports streaming provider requests");
			}
			const resolvedKey = await resolveApiKeyOnce(gatewayKey, options?.signal);
			const authorization =
				getHeaderCaseInsensitive(options?.headers, "authorization") ??
				getHeaderCaseInsensitive(model.headers, "authorization");
			const apiKey = resolvedKey || (authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined);
			const sessionId = options?.sessionId || options?.promptCacheKey || randomUUID();
			const routingFetch = createProviderWireFetch(model, { ...options, apiKey, sessionId });
			let requestFailure: unknown;
			const fetch: FetchImpl = async (input, init) => {
				try {
					return await routingFetch(input, init);
				} catch (error) {
					requestFailure = error;
					throw error;
				}
			};
			const wireOptions = {
				...options,
				apiKey,
				sessionId,
				fetch,
				headers: Object.fromEntries(safeHeaders(options?.headers)),
				isOAuth: true,
			};
			const providerModel: Model<TApi> = {
				...model,
				transport: "provider-wire",
				headers: Object.fromEntries(safeHeaders(model.headers)),
			};
			let inner: AssistantMessageEventStream;
			if (model.api === "anthropic-messages") {
				inner = streamAnthropic(
					{ ...(providerModel as Model<"anthropic-messages">), baseUrl: "https://api.anthropic.com" },
					context,
					wireOptions as AnthropicOptions,
				);
			} else {
				inner = streamOpenAICodexResponses(
					{
						...(providerModel as Model<"openai-codex-responses">),
						baseUrl: CODEX_BASE_URL,
						preferWebsockets: false,
					},
					context,
					{ ...wireOptions, preferWebsockets: false } as OpenAICodexResponsesOptions,
				);
			}
			for await (const event of inner) {
				// Native codecs normalize exceptions into assistant error events.
				// Preserve the gateway's complete error (including arbitrary fields)
				// and original fetch/abort error instead, as pi-native does.
				if (event.type === "error") {
					// No decoded output does not prove non-execution. The transport
					// already owns its bounded known-refusal retries.
					event.error.errorId = create(classifyMessage(event.error), Flag.NoRetry);
					options?.signal?.throwIfAborted();
					if (requestFailure !== undefined) {
						outer.fail(forbidReplay(requestFailure));
						return;
					}
				}
				outer.push(event);
			}
			if (!outer.done) outer.end(await inner.result());
		} catch (error) {
			outer.fail(forbidReplay(error));
		}
	})();
	return outer;
}
