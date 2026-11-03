/**
 * Both halves of keeping a worker's `ModelRegistry` mirror equal to the main
 * thread's registry (wired by `./auth`).
 *
 * Main side: {@link toWireMirrorBatch} turns the registry's change batches
 * (`ModelRegistry.subscribeMirror`) into wire form. Runtime provider configs
 * keep their functions as remote callables; the ones a worker calls
 * synchronously (OAuth `getApiKey`, `modifyModels`) are `rpcSync`; a custom
 * `streamSimple` stays on main behind a {@link MainStreamSimple}; `usage` stays
 * on main, whose `AuthStorage` already serves it.
 *
 * Worker side: {@link fromWireMirrorBatch} rebuilds the configs (a custom API
 * streams through main via {@link proxyStreamSimple}; a `fetch` override in its
 * options keeps running on the worker, bridged request by request), and
 * {@link RemoteModelRegistryOwner} runs the mirror's discovery and refresh calls
 * on main. Main pushes the resulting changes before it answers the call, so the
 * mirror has applied them when the call resolves.
 */
import type { Api, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { ModelRefreshStrategy } from "@oh-my-pi/pi-catalog/model-manager";
import { type FetchImpl, logger } from "@oh-my-pi/pi-utils";
import type {
	ModelRegistryMirrorBatch,
	ModelRegistryMirrorChange,
	ModelRegistryOwner,
	ModelRegistryRefreshOptions,
	ProviderConfigInput,
} from "../../config/model-registry";
import { type RemoteObject, registerRpcError, rpcSync } from "../rpc";
import type {
	MainStreamSimple,
	ModelRegistryProtocol,
	WireFetchResponse,
	WireMirrorBatch,
	WireMirrorChange,
	WireProviderConfig,
	WireStreamOptions,
	WorkerFetch,
} from "./auth-protocol";
import { ignoreSettle } from "./support";

// `fetch` reports network failures as `TypeError`; keep the class across the bridge.
registerRpcError("TypeError", message => new TypeError(message));

type StreamSimple = NonNullable<ProviderConfigInput["streamSimple"]>;
type ProviderOAuth = NonNullable<ProviderConfigInput["oauth"]>;

// ─────────────────────────────────────────────────────────────────────────────
// Main side
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main side: a `fetch` that runs the worker's. The request is buffered and
 * described (method, URL, headers, body bytes, redirect mode, abort signal);
 * the returned `Response` carries the worker response's status, headers and
 * URL, and its body pulls the worker body chunk by chunk, in order. Aborts,
 * rejections and body errors surface as the worker's fetch raised them.
 */
function fetchThroughWorker(fetchOnWorker: WorkerFetch): FetchImpl {
	return async (input, init) => {
		const request =
			input instanceof Request
				? new Request(input, init)
				: new Request(typeof input === "string" ? input : input.href, init);
		const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
		const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
		const head = await fetchOnWorker({
			url: request.url,
			method: request.method,
			headers: [...request.headers],
			body,
			redirect: request.redirect,
			signal: signal ?? undefined,
		});
		const source = head.body;
		const stream = source
			? new ReadableStream<Uint8Array>(
					{
						async pull(controller) {
							const chunk = await source.read();
							if (chunk === undefined) controller.close();
							else controller.enqueue(chunk);
						},
						cancel: reason => source.cancel(reason),
					},
					// Pull one chunk per read: the worker reads only what main consumes.
					{ highWaterMark: 0 },
				)
			: null;
		const response = new Response(stream, {
			status: head.status,
			statusText: head.statusText,
			headers: head.headers,
		});
		if (head.url) Object.defineProperty(response, "url", { value: head.url });
		if (head.redirected) Object.defineProperty(response, "redirected", { value: true });
		return response;
	};
}

/** Main side: a worker's stream options with its `fetch` rebuilt over the bridge. */
function streamOptionsOnMain(options: WireStreamOptions | undefined): SimpleStreamOptions | undefined {
	if (!options) return undefined;
	const { fetchOnWorker, ...rest } = options;
	return fetchOnWorker ? { ...rest, fetch: fetchThroughWorker(fetchOnWorker) } : rest;
}

/** Run `streamSimple` here for a worker: every event goes to its sink in order, then the final message. */
function streamOnMain(streamSimple: StreamSimple): MainStreamSimple {
	return async (model, context, options, sink) => {
		const stream = streamSimple(model, context, streamOptionsOnMain(options));
		// Not awaited: sink calls reach the worker in send order, ahead of this call's own reply.
		for await (const event of stream) ignoreSettle(sink(event));
		try {
			return await stream.result();
		} catch {
			// Ended without a final result; the worker's `end()` reports that the same way.
			return undefined;
		}
	};
}

/** OAuth hooks for a worker: the synchronous ones answer its blocking calls. */
function oauthOnMain(oauth: ProviderOAuth): ProviderOAuth {
	const view: ProviderOAuth = { name: oauth.name, login: callbacks => oauth.login(callbacks) };
	const { refreshToken, getApiKey, modifyModels } = oauth;
	if (refreshToken) view.refreshToken = credentials => refreshToken.call(oauth, credentials);
	if (getApiKey) view.getApiKey = rpcSync(credentials => getApiKey.call(oauth, credentials));
	if (modifyModels)
		view.modifyModels = rpcSync((models, credentials) => modifyModels.call(oauth, models, credentials));
	return view;
}

function toWireProviderConfig(config: ProviderConfigInput): WireProviderConfig {
	const { streamSimple, usage: _usage, oauth, ...rest } = config;
	const wire: WireProviderConfig = rest;
	if (oauth) wire.oauth = oauthOnMain(oauth);
	if (streamSimple) wire.streamOnMain = streamOnMain(streamSimple);
	return wire;
}

function toWireChange(change: ModelRegistryMirrorChange): WireMirrorChange {
	return change.kind === "register" ? { ...change, config: toWireProviderConfig(change.config) } : change;
}

/** Main side: a registry change batch in the form a worker mirror receives. */
export function toWireMirrorBatch(batch: ModelRegistryMirrorBatch): WireMirrorBatch {
	return { ...batch, changes: batch.changes.map(toWireChange) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker side
// ─────────────────────────────────────────────────────────────────────────────

/** Whether `value` survives the link: data, functions, abort signals, and plain containers of them. */
function crossesLink(value: unknown): boolean {
	if (typeof value === "symbol") return false;
	if (typeof value !== "object" || value === null) return true;
	if (value instanceof AbortSignal || value instanceof Date || ArrayBuffer.isView(value)) return true;
	if (Array.isArray(value)) return value.every(crossesLink);
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	for (const key in value) {
		if (!crossesLink(Reflect.get(value, key))) return false;
	}
	return true;
}

/** Worker side: run this thread's `fetch` for main (see {@link fetchThroughWorker}). */
function workerFetch(fetchImpl: FetchImpl): WorkerFetch {
	return async ({ url, method, headers, body, redirect, signal }) => {
		const response = await fetchImpl(url, { method, headers, body, redirect, signal });
		const head: WireFetchResponse = {
			status: response.status,
			statusText: response.statusText,
			headers: [...response.headers],
			url: response.url,
			redirected: response.redirected,
		};
		if (!response.body) return head;
		const reader = response.body.getReader();
		head.body = {
			read: async () => {
				const { done, value } = await reader.read();
				return done ? undefined : value;
			},
			cancel: reason => reader.cancel(reason),
		};
		return head;
	};
}

/**
 * Stream options a main-side `streamSimple` can receive. Callbacks with data
 * results cross as async remote functions and the abort signal is mirrored on
 * main; `fetch` (whose `Response` cannot cross) is bridged by
 * {@link workerFetch}. Thread-local state (per-session `Map`s, live class
 * instances) and the Anthropic slow-mode hooks (a synchronous `isActive` main
 * cannot ask a worker) stay behind.
 */
function streamOptionsForMain(options: SimpleStreamOptions | undefined): WireStreamOptions | undefined {
	if (!options) return undefined;
	const sent: WireStreamOptions = {};
	const dropped: string[] = [];
	for (const key in options) {
		const value: unknown = Reflect.get(options, key);
		if (key === "fetch" || key === "anthropicSlowMode" || value === undefined) continue;
		if (crossesLink(value)) Reflect.set(sent, key, value);
		else dropped.push(key);
	}
	if (options.fetch) sent.fetchOnWorker = workerFetch(options.fetch);
	if (options.anthropicSlowMode) dropped.push("anthropicSlowMode");
	if (dropped.length > 0) logger.debug("Custom API stream options kept on the worker", { dropped });
	return sent;
}

/**
 * Worker side: a custom API `streamSimple` whose stream runs on main. Events
 * arrive in order; abort crosses with the signal; a stream that throws on main
 * fails this one with the same error, and one that ends without a terminal
 * event ends this one with main's final result.
 */
export function proxyStreamSimple(streamOnMain: MainStreamSimple): StreamSimple {
	return (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
		const stream = new AssistantMessageEventStream();
		streamOnMain(model, context, streamOptionsForMain(options), (event: AssistantMessageEvent) =>
			stream.push(event),
		).then(
			result => {
				if (!stream.done) stream.end(result);
			},
			(error: unknown) => stream.fail(error),
		);
		return stream;
	};
}

function fromWireProviderConfig(wire: WireProviderConfig): ProviderConfigInput {
	const { streamOnMain, ...config } = wire;
	return streamOnMain ? { ...config, streamSimple: proxyStreamSimple(streamOnMain) } : config;
}

function fromWireChange(change: WireMirrorChange): ModelRegistryMirrorChange {
	return change.kind === "register" ? { ...change, config: fromWireProviderConfig(change.config) } : change;
}

/** Worker side: a received batch as the mirror registry applies it. */
export function fromWireMirrorBatch(batch: WireMirrorBatch): ModelRegistryMirrorBatch {
	return { ...batch, changes: batch.changes.map(fromWireChange) };
}

/** Worker side: the main-thread registry a mirror forwards discovery and refresh calls to. */
export class RemoteModelRegistryOwner implements ModelRegistryOwner {
	readonly #remote: RemoteObject<ModelRegistryProtocol>;

	constructor(remote: RemoteObject<ModelRegistryProtocol>) {
		this.#remote = remote;
	}

	invalidateCommandConfigs(provider?: string): void {
		this.#remote.notify("invalidateCommandConfigs", provider);
	}

	refresh(strategy: ModelRefreshStrategy, options?: ModelRegistryRefreshOptions): Promise<void> {
		return this.#remote.call("refresh", strategy, options);
	}

	refreshProvider(
		providerId: string,
		strategy: ModelRefreshStrategy,
		options?: ModelRegistryRefreshOptions,
	): Promise<void> {
		return this.#remote.call("refreshProvider", providerId, strategy, options);
	}

	refreshDiscoverableProviders(providerIds: string[], strategy: ModelRefreshStrategy): Promise<void> {
		return this.#remote.call("refreshDiscoverableProviders", providerIds, strategy);
	}

	refreshRuntimeProviders(strategy: ModelRefreshStrategy): Promise<void> {
		return this.#remote.call("refreshRuntimeProviders", strategy);
	}

	hydrateCredentialScopedModelCaches(): Promise<void> {
		return this.#remote.call("hydrateCredentialScopedModelCaches");
	}

	reapplyModelPolicies(): Promise<void> {
		return this.#remote.call("reapplyModelPolicies");
	}

	refreshInBackground(strategy: ModelRefreshStrategy): void {
		this.#remote.notify("refreshInBackground", strategy);
	}

	isBackgroundRefreshPending(): boolean {
		return this.#remote.callSync("isBackgroundRefreshPending");
	}

	awaitBackgroundRefresh(): Promise<void> {
		return this.#remote.call("awaitBackgroundRefresh");
	}

	refreshIfStale(): Promise<boolean> {
		return this.#remote.call("refreshIfStale");
	}

	awaitInitialBackgroundRefresh(signal?: AbortSignal): Promise<void> {
		return this.#remote.call("awaitInitialBackgroundRefresh", signal);
	}
}
