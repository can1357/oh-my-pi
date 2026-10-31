import { isCatalogEndpointUrl } from "@oh-my-pi/pi-catalog/compat/catalog-endpoint";
import { logger } from "@oh-my-pi/pi-utils";
import { getCustomApi } from "../api-registry";
import { getProviderDefinition } from "../registry/registry";
import type { Api, FetchImpl, Model } from "../types";
import { lastDispatchOrigin, transportFetch } from "../utils/transport-fetch";
import {
	buildClaudeCodeTlsFetchOptions,
	resolveAnthropicBaseUrl,
	resolveAnthropicPrewarmTarget,
} from "./anthropic-http-options";
import { OPENAI_COMPLETIONS_BASE_URL_OPTIONS, resolveOpenAIRequestBaseUrl } from "./openai-base-url";
import { isAnthropicMessagesModel } from "./transform-messages";

/**
 * Providers that `stream.ts` (`streamSimpleRequest`, `streamDispatch`) hands to
 * a handler of their own, which sends to hosts other than the API transport's.
 */
const OWN_DISPATCH_PROVIDERS: Record<string, true> = { "gitlab-duo": true, "kimi-code": true, synthetic: true };

/**
 * Whether {@link model}'s request reaches its API transport unchanged, so the
 * transport's own endpoint resolver gives the host before any request. Not
 * when an extension owns the API, the provider's definition reshapes the model
 * or request (`prepareModel` / `prepareRequest`: Snowflake's account origin,
 * Cloudflare's account and gateway, Bedrock Mantle's region), or the provider
 * has a dispatch of its own ({@link OWN_DISPATCH_PROVIDERS}).
 */
function reachesApiTransportUnchanged(model: Model<Api>): boolean {
	if (getCustomApi(model.api) || Object.hasOwn(OWN_DISPATCH_PROVIDERS, model.provider)) return false;
	const definition = getProviderDefinition(model.provider);
	return !definition?.prepareModel && !definition?.prepareRequest;
}

/**
 * Minimum gap between warm-ups of one origin. Idle pooled sockets outlive it
 * by minutes (Copilot drops them after ~2.5–5 min, most hosts later), so a
 * tighter cadence would only add requests.
 */
const PREWARM_INTERVAL_MS = 30_000;
const PREWARM_TIMEOUT_MS = 10_000;
/** A host that has not answered a `HEAD` in this long counts as unreachable. */
const PROBE_TIMEOUT_MS = 5_000;
/** How long one probe answers for its provider and origin; long enough to share between back-to-back callers. */
const PROBE_CACHE_MS = 10_000;

const prewarmedAt = new Map<string, number>();
interface ProbeEntry {
	at: number;
	reachable: Promise<boolean>;
}
/**
 * Probes by transport, then by provider and origin. A caller-supplied fetch is
 * its own transport, and each provider has its own proxy and TLS options, so an
 * answer is only reused where the request would travel the same way. Probes
 * through a caller-supplied fetch live only as long as that fetch does.
 */
const defaultProbes = new Map<string, ProbeEntry>();
let fetchProbes = new WeakMap<FetchImpl, Map<string, ProbeEntry>>();

/**
 * Where a warm-up for {@link model} goes, or `undefined` when it must not be
 * probed. First-party Anthropic resolves its effective endpoint (following
 * `ANTHROPIC_BASE_URL`/Foundry reroutes) and TLS options up front. Every
 * other model warms only the origin its last inference request actually
 * reached, so credential endpoints (Copilot plans), env overrides
 * (`MOONSHOT_BASE_URL`, `XAI_BASE_URL`), and regional hosts are never guessed
 * from `baseUrl`; before its first request there is nothing to warm. That
 * origin must also be the provider's own endpoint: a custom provider, or a
 * catalog provider id routed to a gateway, proxy, or local server, is never
 * probed.
 */
function resolvePrewarmTarget(model: Model<Api>): { origin: string; init: RequestInit } | undefined {
	if (model.provider === "anthropic") {
		const target = resolveAnthropicPrewarmTarget(model);
		return target && { origin: new URL(target.url).origin, init: target.init };
	}
	const origin = lastDispatchOrigin(model);
	if (!origin || !isCatalogEndpointUrl(model, origin)) return undefined;
	return { origin, init: {} };
}

/**
 * Opens, or keeps alive, a pooled connection to {@link model}'s API host so
 * the next turn skips DNS + TCP + TLS. Sends a credential-less `HEAD` (nothing
 * is billed; hosts answer 401/404/405) through the same transport — proxy,
 * extra CA, Cowork profile, TLS options — as real requests, because sockets
 * pool per transport configuration and a warm-up made any other way (e.g.
 * `fetch.preconnect`, which also throws on Windows) is never reused.
 * Throttled per origin; best effort, never throws.
 */
export async function prewarmModelConnection(model: Model<Api>, options?: { fetch?: FetchImpl }): Promise<void> {
	let origin: string | undefined;
	try {
		// Inside the boundary: resolving Anthropic's TLS options throws on an
		// unusable CA or client-certificate setup, which the real request reports.
		const target = resolvePrewarmTarget(model);
		if (!target) return;
		origin = target.origin;
		const now = Date.now();
		const last = prewarmedAt.get(origin);
		if (last !== undefined && now - last < PREWARM_INTERVAL_MS) return;
		prewarmedAt.set(origin, now);
		const response = await transportFetch(model, options?.fetch)(origin, {
			...target.init,
			method: "HEAD",
			headers: {},
			signal: AbortSignal.timeout(PREWARM_TIMEOUT_MS),
		});
		await response.body?.cancel();
	} catch (error) {
		logger.debug("Model connection prewarm failed", {
			origin,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Where a reachability probe for {@link model} goes, resolved by the same code
 * its requests use, or `undefined` when that route cannot be worked out here.
 * Unlike a warm-up, gateways, custom providers and local servers are probed
 * too: a local server is the one host that still answers offline.
 *
 * - `transport: "pi-native"`: the gateway at `baseUrl`, whatever the API. The
 *   client POSTs every turn to `baseUrl/v1/pi/stream` through the same
 *   transport fetch, before any custom API, provider preparer or provider
 *   dispatch, with no provider endpoint rules or TLS options.
 * - A request that does not reach its API transport unchanged
 *   ({@link reachesApiTransportUnchanged}): only the origin the model last
 *   sent to.
 * - `anthropic-messages`: the client's base URL and TLS options for `apiKey`.
 * - `openai-completions`, `openai-responses`: the request setup's base URL for
 *   `apiKey` (env overrides, Copilot plan host, credential endpoints). Dispatch
 *   history is shared by every session and account, so it is used only when
 *   that resolves nothing.
 * - Any other API: only the origin the model last sent to. Those transports
 *   have their own endpoint rules, so before a first request there is nothing
 *   to probe that is not a guess.
 *
 * A `.invalid` host (RFC 6761, used for catalog placeholders) is never a route.
 */
function resolveProbeTarget(
	model: Model<Api>,
	apiKey: string | undefined,
): { origin: string; init: RequestInit } | undefined {
	let url: string | undefined;
	let init: RequestInit = {};
	if (model.transport === "pi-native") {
		url = model.baseUrl;
	} else if (!reachesApiTransportUnchanged(model)) {
		url = lastDispatchOrigin(model);
	} else if (isAnthropicMessagesModel(model)) {
		url = resolveAnthropicBaseUrl(model, apiKey);
		if (url) init = { ...buildClaudeCodeTlsFetchOptions(model, url) };
	} else if (model.api === "openai-completions" || model.api === "openai-responses") {
		const resolved =
			apiKey === undefined
				? undefined
				: resolveOpenAIRequestBaseUrl(
						model,
						apiKey,
						model.api === "openai-completions" ? OPENAI_COMPLETIONS_BASE_URL_OPTIONS : undefined,
					);
		url = resolved ?? lastDispatchOrigin(model);
	} else {
		url = lastDispatchOrigin(model);
	}
	if (!url) return undefined;
	const target = new URL(url);
	return target.hostname.endsWith(".invalid") ? undefined : { origin: target.origin, init };
}

/**
 * Whether {@link model}'s API host answers at all. Sends a credential-less
 * `HEAD` through the same transport as real requests (proxy, extra CA, TLS
 * options), so it fails exactly when a request would fail to connect. Any
 * HTTP response counts as reachable, a redirect included (it is not
 * followed); a rejected fetch or no answer within
 * {@link PROBE_TIMEOUT_MS} does not. `apiKey` is the credential the request
 * would use: some providers route by it. A model whose route cannot be worked
 * out counts as reachable, so a caller never skips it on a guessed URL. One
 * probe per transport, provider and origin answers for {@link PROBE_CACHE_MS}.
 *
 * `signal` stops this caller's wait only, resolving `false`: the shared probe
 * keeps running for any other caller of the same origin.
 */
export function probeModelConnection(
	model: Model<Api>,
	options?: { apiKey?: string; fetch?: FetchImpl; signal?: AbortSignal },
): Promise<boolean> {
	let target: { origin: string; init: RequestInit } | undefined;
	try {
		target = resolveProbeTarget(model, options?.apiKey);
	} catch {
		// Resolving the route throws on an unusable CA or client certificate
		// (Anthropic) or a malformed credential (Copilot); the real request reports it.
		target = undefined;
	}
	if (!target) return Promise.resolve(true);
	const { origin, init } = target;
	const now = Date.now();
	let transportProbes = defaultProbes;
	if (options?.fetch) {
		transportProbes = fetchProbes.get(options.fetch) ?? new Map();
		fetchProbes.set(options.fetch, transportProbes);
	}
	const key = `${model.provider}\u0000${origin}`;
	const cached = transportProbes.get(key);
	let reachable = cached && now - cached.at < PROBE_CACHE_MS ? cached.reachable : undefined;
	if (!reachable) {
		reachable = (async () => {
			try {
				const response = await transportFetch(model, options?.fetch)(origin, {
					...init,
					method: "HEAD",
					headers: {},
					// The first answer proves the host is up; a redirect target may be a
					// docs or login host the API requests never touch.
					redirect: "manual",
					signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
				});
				await response.body?.cancel();
				return true;
			} catch (error) {
				logger.debug("Model connection probe failed", {
					origin,
					error: error instanceof Error ? error.message : String(error),
				});
				return false;
			}
		})();
		transportProbes.set(key, { at: now, reachable });
	}
	const signal = options?.signal;
	if (!signal) return reachable;
	if (signal.aborted) return Promise.resolve(false);
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const onAbort = (): void => resolve(false);
	signal.addEventListener("abort", onAbort, { once: true });
	void reachable.then(resolve).finally(() => signal.removeEventListener("abort", onAbort));
	return promise;
}

/** Test hook: forgets every warm-up and probe so the next call is not throttled or cached. */
export function resetConnectionPrewarmForTesting(): void {
	prewarmedAt.clear();
	defaultProbes.clear();
	fetchProbes = new WeakMap();
}
