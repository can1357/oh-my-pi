/**
 * Auth bridge between the main thread and subagent workers.
 *
 * - `AuthStorage` crosses by reference: a worker receives one canonical
 *   `AuthStorage` per main instance, built over {@link RemoteAuthStorageBackend},
 *   so every namespace call runs against the main thread's state. Restriction
 *   leases and listener subscriptions a worker holds are released when it exits.
 * - `ModelRegistry` crosses by reference too, but the worker builds ONE local
 *   mirror per main registry (`ModelRegistry` `owner` option) from the same
 *   construction inputs (models.yml, model cache db, `ignoreLocalModelConfig`,
 *   settings) over the worker `AuthStorage`, then subscribes to main's runtime
 *   state: a snapshot at build, then every change batch in order (see
 *   `./model-registry-mirror`). Runtime providers main registers or drops
 *   (extensions, SDK callers) replay in the mirror — custom stream APIs stream
 *   through main, OAuth and `modifyModels` hooks run on main, runtime API keys
 *   resolve through main's `AuthStorage` — and main's in-memory discovery layer
 *   replaces the mirror's own. Discovery and refresh calls on the mirror run on
 *   main; runtime registration calls on it are dropped (worker-side extension
 *   instances repeat what the parent registered on main), so main stays the one
 *   source of truth. The mirror never installs key config into the shared
 *   `AuthStorage` and forwards `!command` cache invalidations to main.
 *   {@link prewarmModelRegistryMirror} builds and composes a mirror eagerly.
 * - The Anthropic slow-mode lane registry: the worker's process singleton takes
 *   its lanes from main's, so every thread shares one state per account.
 */
import { AuthStorage, type SessionRestrictionLease, type UsageProvider } from "@oh-my-pi/pi-ai";
import { AuthBrokerError, AuthBrokerStreamUnsupportedError } from "@oh-my-pi/pi-ai/auth-broker";
import { getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import {
	ApiKeyRequiredError,
	ConfigurationError,
	LoginCancelledError,
	MissingApiKeyError,
	OAuthError,
	OAuthRefreshUnavailableError,
	OnPromptRequiredError,
} from "@oh-my-pi/pi-ai/error";
import { logger } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../config/model-registry";
import {
	AnthropicSlowModeController,
	type AnthropicSlowModeHookOptions,
	AnthropicSlowModeLanes,
	anthropicSlowModeLanes,
} from "../../session/anthropic-slow-mode";
import type { MainThreadLink, WorkerThreadLink } from "../protocol";
import { type RemoteObject, type RpcServe, registerRpcError, rpcSync } from "../rpc";
import type { ThreadService, WorkerPeer } from "../services";
import {
	AUTH_STORAGE_KIND,
	type AuthAvailabilityTable,
	type AuthStorageProtocol,
	type BaseUrlTable,
	MODEL_REGISTRY_KIND,
	type ModelRegistryProtocol,
	type ProviderAuthAvailability,
	SLOW_MODE_LANE_KIND,
	SLOW_MODE_LANES_KIND,
	type SlowModeLaneProtocol,
	type SlowModeLanesProtocol,
	type WireSlowModeHookOptions,
} from "./auth-protocol";
import {
	invalidateRemoteAuthAvailability,
	RemoteAuthStorageBackend,
	RemoteSlowModeLane,
	RemoteSlowModeLanes,
} from "./auth-remote";
import { fromWireMirrorBatch, RemoteModelRegistryOwner, toWireMirrorBatch } from "./model-registry-mirror";
import { trackWorkerSubscription, type WireCallback } from "./support";

/** Worker function that builds, composes, and keeps its mirror of a main registry. */
type MirrorHost = WireCallback<[registry: ModelRegistry]>;

/** Boot globals of {@link authService}. */
export interface AuthServiceGlobals {
	/** Main thread's slow-mode lane registry (a {@link RemoteSlowModeLanes} on the worker). */
	readonly slowModeLanes: AnthropicSlowModeLanes;
	/** The worker hands main its mirror host at boot; {@link prewarmModelRegistryMirror} calls it. */
	readonly attachMirrorHost: (host: MirrorHost) => void;
}

/** One `sessions.restrict` lease a worker holds, by the id it knows. */
interface HeldLease {
	readonly storage: AuthStorage;
	readonly provider: string;
	readonly sessionId: string;
	readonly lease: SessionRestrictionLease;
}

/** Main-side auth state of one worker, released when it exits. */
class PeerAuthState {
	readonly leases = new Map<number, HeldLease>();
	readonly subscriptions = new Set<() => void>();
	readonly mirrorHost = Promise.withResolvers<MirrorHost>();
	#nextLease = 1;

	constructor() {
		// Rejected when the worker exits before attaching; only prewarm callers observe it.
		this.mirrorHost.promise.catch(() => {});
	}

	hold(lease: HeldLease): number {
		const id = this.#nextLease++;
		this.leases.set(id, lease);
		return id;
	}

	release(): void {
		for (const held of this.leases.values())
			held.storage.sessions.unrestrict(held.provider, held.sessionId, held.lease);
		this.leases.clear();
		// Each unsubscribe deletes its own (already visited) entry, which Set iteration tolerates.
		for (const unsubscribe of this.subscriptions) unsubscribe();
		this.mirrorHost.reject(new Error("Worker exited before its model registry mirror host attached"));
	}
}

const kPeerAuth = Symbol("thread.auth.peer");
const kUsageProviderView = Symbol("thread.auth.usageProviderView");

/** This worker link's auth state, created on first use. */
function peerState(link: MainThreadLink): PeerAuthState {
	const existing: unknown = Reflect.get(link, kPeerAuth);
	if (existing instanceof PeerAuthState) return existing;
	const state = new PeerAuthState();
	Reflect.set(link, kPeerAuth, state);
	return state;
}

/** Swallow a rejection from a worker callback (its link may be closing); returns nothing either way. */
function settleQuietly(result: unknown): void {
	if (result instanceof Promise) {
		result.catch((error: unknown) => logger.debug("Worker auth callback failed", { error: String(error) }));
	}
}

function tableResolver(table: BaseUrlTable | undefined): ((provider: string) => string | undefined) | undefined {
	return table ? provider => table[provider] : undefined;
}

function isUsageProvider(value: unknown): value is UsageProvider {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "fetchUsage") === "function";
}

/**
 * What a worker receives for `usage.providerFor`: the same provider with its
 * synchronous hooks marked `rpcSync`, cached on the provider so repeated
 * lookups export the same functions.
 */
function usageProviderView(provider: UsageProvider): UsageProvider {
	const cached: unknown = Reflect.get(provider, kUsageProviderView);
	if (isUsageProvider(cached)) return cached;
	const view: UsageProvider = {
		id: provider.id,
		cacheVersion: provider.cacheVersion,
		validatesCredentials: provider.validatesCredentials,
		retainLastGoodOnFailure: provider.retainLastGoodOnFailure,
		failureBackoffMs: provider.failureBackoffMs,
		usesRequestKey: provider.usesRequestKey,
		fetchUsage: (params, ctx) => provider.fetchUsage(params, ctx),
	};
	const parse = provider.parseRateLimitHeaders;
	if (parse)
		view.parseRateLimitHeaders = rpcSync((headers, now, context) => parse.call(provider, headers, now, context));
	const supports = provider.supports;
	if (supports) view.supports = rpcSync(params => supports.call(provider, params));
	Reflect.set(provider, kUsageProviderView, view);
	return view;
}

/** Answer `keys.availabilityOf`: see {@link AuthStorageProtocol}. */
function providerAvailability(storage: AuthStorage, provider: string): ProviderAuthAvailability {
	return {
		source: storage.keys.source(provider),
		keyless: storage.keys.keyless(provider),
		oauth: storage.credentials.hasOAuth(provider),
	};
}

/** Answer `keys.availability`: see {@link AuthStorageProtocol}. */
function authAvailability(storage: AuthStorage, providers: readonly string[]): AuthAvailabilityTable {
	const domain = new Set<string>(getBundledProviders());
	for (const provider in storage.credentials.all()) domain.add(provider);
	for (const provider of providers) domain.add(provider);
	const table: AuthAvailabilityTable = {};
	for (const provider of domain) table[provider] = providerAvailability(storage, provider);
	return table;
}
/** Main-side implementation of {@link AuthStorageProtocol} for one worker. */
function serveAuthStorage(state: PeerAuthState): RpcServe<AuthStorage, AuthStorageProtocol> {
	return {
		"credentials.generation": storage => storage.credentials.generation,
		"credentials.onGeneration": (storage, listener) =>
			trackWorkerSubscription(
				state.subscriptions,
				storage.credentials.onGeneration(generation => settleQuietly(listener(generation))),
			),
		"credentials.onDisabled": (storage, listener) =>
			trackWorkerSubscription(state.subscriptions, storage.credentials.onDisabled(listener)),
		"credentials.reload": storage => storage.credentials.reload(),
		"credentials.poll": storage => storage.credentials.poll(),
		"credentials.revalidate": storage => storage.credentials.revalidate(),
		"credentials.get": (storage, provider) => storage.credentials.get(provider),
		"credentials.all": storage => storage.credentials.all(),
		"credentials.list": (storage, provider) => storage.credentials.list(provider),
		"credentials.has": (storage, provider) => storage.credentials.has(provider),
		"credentials.hasOAuth": (storage, provider) => storage.credentials.hasOAuth(provider),
		"credentials.hasSubscription": (storage, provider) => storage.credentials.hasSubscription(provider),
		"credentials.getOAuth": (storage, provider) => storage.credentials.getOAuth(provider),
		"credentials.set": (storage, provider, credential) => storage.credentials.set(provider, credential),
		"credentials.upsert": (storage, provider, credential) => storage.credentials.upsert(provider, credential),
		"credentials.remove": (storage, provider) => storage.credentials.remove(provider),
		"credentials.removeById": (storage, provider, id) => storage.credentials.removeById(provider, id),
		"credentials.disable": (storage, id, cause) => storage.credentials.disable(id, cause),
		"credentials.listDisabled": (storage, provider, signal) => storage.credentials.listDisabled(provider, signal),
		"credentials.snapshot": storage => storage.credentials.snapshot(),

		"keys.get": (storage, provider, sessionId, options) => storage.keys.get(provider, sessionId, options),
		"keys.prefetchUsage": (storage, provider, sessionId, options) =>
			storage.keys.prefetchUsage(provider, sessionId, options),
		"keys.getWithCredential": (storage, provider, sessionId, options) =>
			storage.keys.getWithCredential(provider, sessionId, options),
		"keys.peek": (storage, provider, options) => storage.keys.peek(provider, options),
		"keys.source": (storage, provider, options) => storage.keys.source(provider, options),
		"keys.availability": (storage, providers) => authAvailability(storage, providers),
		"keys.availabilityOf": (storage, provider) => providerAvailability(storage, provider),
		"keys.describe": (storage, provider, sessionId) => storage.keys.describe(provider, sessionId),
		"keys.setRuntime": (storage, provider, apiKey) => storage.keys.setRuntime(provider, apiKey),
		"keys.removeRuntime": (storage, provider) => storage.keys.removeRuntime(provider),
		"keys.setConfig": (storage, provider, config, options) => storage.keys.setConfig(provider, config, options),
		"keys.removeConfig": (storage, provider) => storage.keys.removeConfig(provider),
		"keys.clearConfig": storage => storage.keys.clearConfig(),
		"keys.setResolver": (storage, resolver) => storage.keys.setResolver(resolver),
		"keys.resolver": (storage, provider, options) => storage.keys.resolver(provider, options),

		"oauth.login": (storage, provider, ctrl) => storage.oauth.login(provider, ctrl),
		"oauth.access": (storage, provider, sessionId, options) => storage.oauth.access(provider, sessionId, options),
		"oauth.accessAll": (storage, provider, options) => storage.oauth.accessAll(provider, options),
		"oauth.accessById": (storage, provider, id, options) => storage.oauth.accessById(provider, id, options),
		"oauth.accounts": (storage, provider, sessionId) => storage.oauth.accounts(provider, sessionId),
		"oauth.identity": (storage, provider, sessionId) => storage.oauth.identity(provider, sessionId),
		"oauth.policy": (storage, provider, identity) => storage.oauth.policy(provider, identity),
		"oauth.refresh": (storage, id, signal, options) => storage.oauth.refresh(id, signal, options),

		"sessions.pin": (storage, provider, sessionId, credentialId, options) =>
			storage.sessions.pin(provider, sessionId, credentialId, options),
		"sessions.inherit": (storage, source, target, table) =>
			storage.sessions.inherit(
				source,
				target,
				table ? (provider, explicit) => table[provider]?.[explicit ? 1 : 0] ?? false : undefined,
			),
		"sessions.restrict": (storage, provider, sessionId, identityKeys) =>
			state.hold({
				storage,
				provider,
				sessionId,
				lease: storage.sessions.restrict(provider, sessionId, identityKeys),
			}),
		"sessions.unrestrict": (storage, provider, sessionId, id) => {
			const held = state.leases.get(id);
			if (!held || held.storage !== storage) return;
			storage.sessions.unrestrict(provider, sessionId, held.lease);
			// A call naming another session is a no-op that leaves the lease usable, as in-process.
			if (held.provider === provider && held.sessionId === sessionId) state.leases.delete(id);
		},
		"sessions.permits": (storage, provider, sessionId, credentialId) =>
			storage.sessions.permits(provider, sessionId, credentialId),
		"sessions.release": (storage, provider, sessionId) => storage.sessions.release(provider, sessionId),

		"usage.reports": (storage, options) =>
			storage.usage.reports({
				provider: options?.provider,
				signal: options?.signal,
				baseUrlResolver: tableResolver(options?.baseUrls),
			}),
		"usage.ingestHeaders": (storage, provider, headers, options) =>
			storage.usage.ingestHeaders(provider, headers, options),
		"usage.invalidate": (storage, provider, signal) => storage.usage.invalidate(provider, signal),
		"usage.history": (storage, query) => storage.usage.history(query),
		"usage.observe": (storage, entry) => storage.usage.observe(entry),
		"usage.recordClient": (storage, report) => storage.usage.recordClient(report),
		"usage.clientSummary": (storage, sinceMs) => storage.usage.clientSummary(sinceMs),
		"usage.providerFor": (storage, provider) => {
			const usageProvider = storage.usage.providerFor(provider);
			return usageProvider ? usageProviderView(usageProvider) : undefined;
		},
		"usage.reportingModelIds": (storage, provider, modelIds, reports) =>
			storage.usage.reportingModelIds(provider, modelIds, reports),
		"usage.setProvider": (storage, provider, usageProvider, apiKey) =>
			storage.usage.setProvider(provider, usageProvider, apiKey),
		"usage.removeProvider": (storage, provider) => storage.usage.removeProvider(provider),
		"usage.replaceConfiguredProviders": (storage, providers) =>
			storage.usage.replaceConfiguredProviders(new Map(providers)),

		"health.model": (storage, provider, options) => storage.health.model(provider, options),
		"health.check": (storage, options) => {
			if (!options) return storage.health.check();
			const { baseUrls, ...rest } = options;
			return storage.health.check({ ...rest, baseUrlResolver: tableResolver(baseUrls) });
		},

		"limits.markReached": (storage, provider, sessionId, options) =>
			storage.limits.markReached(provider, sessionId, options),
		"limits.rotate": (storage, provider, sessionId, options) => storage.limits.rotate(provider, sessionId, options),
		"limits.invalidateMatching": (storage, provider, apiKey, options) =>
			storage.limits.invalidateMatching(provider, apiKey, options),

		"resets.list": (storage, options) => {
			if (!options) return storage.resets.list();
			const { baseUrls, ...rest } = options;
			return storage.resets.list({ ...rest, baseUrlResolver: tableResolver(baseUrls) });
		},
		"resets.redeem": (storage, options) => {
			const { baseUrls, ...rest } = options;
			return storage.resets.redeem({ ...rest, baseUrlResolver: tableResolver(baseUrls) });
		},

		"blocks.list": (storage, credentialIds) => storage.blocks.list(credentialIds),
		"blocks.upsert": (storage, block) => storage.blocks.upsert(block),
		"blocks.delete": (storage, credentialId, providerKey, blockScope) =>
			storage.blocks.delete(credentialId, providerKey, blockScope),
		"blocks.deleteAll": (storage, credentialId) => storage.blocks.deleteAll(credentialId),

		setAccountPolicies: (storage, config) => storage.setAccountPolicies(config),
	};
}

/** Rebuild a worker's slow-mode hook options; its `notify` may reject once the link closes. */
function hookOptions(wire: WireSlowModeHookOptions): AnthropicSlowModeHookOptions {
	const notify = wire.notify;
	return {
		lowPriority: () => wire.lowPriority,
		canAutoAccept: wire.canAutoAccept,
		notify: notify ? (level, message) => settleQuietly(notify(level, message)) : undefined,
	};
}

const serveSlowModeLane: RpcServe<AnthropicSlowModeController, SlowModeLaneProtocol> = {
	isActive: (lane, now) => lane.isActive(now),
	activeResetsAtSec: (lane, now) => lane.activeResetsAtSec(now),
	allowanceLeftPercent: lane => lane.allowanceLeftPercent(),
	wrapUpHintKey: (lane, lowPriority, now) => lane.wrapUpHintKey(lowPriority, now),
	status: (lane, now, lowPriority) => lane.status(now, lowPriority),
	availability: (lane, now) => lane.availability(now),
	accept: (lane, now) => lane.accept(now),
	stop: (lane, reason, now) => lane.stop(reason, now),
	reset: lane => lane.reset(),
	observe: (lane, signal, options) => lane.observe(signal, hookOptions(options)),
	onFailure: (lane, failure, options) => lane.onFailure(failure, hookOptions(options)),
};

/** Main-side implementation of {@link ModelRegistryProtocol} for one worker. */
function serveModelRegistry(state: PeerAuthState): RpcServe<ModelRegistry, ModelRegistryProtocol> {
	return {
		mirror: (registry, listener) => {
			const { snapshot, unsubscribe } = registry.subscribeMirror(batch =>
				settleQuietly(listener(toWireMirrorBatch(batch))),
			);
			trackWorkerSubscription(state.subscriptions, unsubscribe);
			return {
				...registry.mirrorInputs(),
				authStorage: registry.authStorage,
				snapshot: toWireMirrorBatch(snapshot),
			};
		},
		invalidateCommandConfigs: (registry, provider) => registry.invalidateCommandConfigs(provider),
		refresh: (registry, strategy, options) => registry.refresh(strategy, options),
		refreshProvider: (registry, providerId, strategy, options) =>
			registry.refreshProvider(providerId, strategy, options),
		refreshDiscoverableProviders: (registry, providerIds, strategy) =>
			registry.refreshDiscoverableProviders(providerIds, strategy),
		refreshRuntimeProviders: (registry, strategy) => registry.refreshRuntimeProviders(strategy),
		hydrateCredentialScopedModelCaches: registry => registry.hydrateCredentialScopedModelCaches(),
		reapplyModelPolicies: registry => registry.reapplyModelPolicies(),
		refreshInBackground: (registry, strategy) => registry.refreshInBackground(strategy),
		isBackgroundRefreshPending: registry => registry.isBackgroundRefreshPending(),
		awaitBackgroundRefresh: registry => registry.awaitBackgroundRefresh(),
		refreshIfStale: registry => registry.refreshIfStale(),
		awaitInitialBackgroundRefresh: (registry, signal) => registry.awaitInitialBackgroundRefresh(signal),
	};
}

/** Build the worker's mirror of a main-thread registry; see the module doc. */
function mirrorModelRegistry(remote: RemoteObject<ModelRegistryProtocol>): ModelRegistry {
	// Batches arrive as later link messages, never during this synchronous build, so `registry` exists by then.
	const wire = remote.callSync("mirror", batch => {
		registry.applyMirrorBatch(fromWireMirrorBatch(batch));
		// Key config (models.yml `apiKey`, runtime providers) changes with the batches.
		invalidateRemoteAuthAvailability(registry.authStorage);
	});
	const registry = new ModelRegistry(wire.authStorage, wire.modelsPath, {
		ignoreLocalModelConfig: wire.ignoreLocalModelConfig,
		cacheDbPath: wire.cacheDbPath,
		settings: wire.settings,
		owner: new RemoteModelRegistryOwner(remote),
	});
	registry.applyMirrorBatch(fromWireMirrorBatch(wire.snapshot));
	return registry;
}

/** Worker side: mirrors built by {@link prewarmModelRegistryMirror}, kept for the worker's life. */
const prewarmedMirrors = new Set<ModelRegistry>();

/**
 * Build worker `peer`'s mirror of `registry` now and compose its catalog
 * (`getAll`, `getAvailable`), so the first subagent session there finds it
 * warm. The mirror stays alive for the worker's life. Resolves once done;
 * rejects when the worker exits first.
 */
export async function prewarmModelRegistryMirror(peer: WorkerPeer, registry: ModelRegistry): Promise<void> {
	const host = await peerState(peer.link).mirrorHost.promise;
	await host(registry);
}

let authErrorsRegistered = false;

/** Rebuild pi-ai auth errors by class on the receiving thread so `instanceof` checks keep working. */
function registerAuthErrors(): void {
	if (authErrorsRegistered) return;
	authErrorsRegistered = true;
	registerRpcError("MissingApiKeyError", message => new MissingApiKeyError(undefined, message));
	registerRpcError("OAuthRefreshUnavailableError", message => {
		const error = new OAuthRefreshUnavailableError("", undefined);
		error.message = message;
		return error;
	});
	registerRpcError("OnPromptRequiredError", message => {
		const error = new OnPromptRequiredError("");
		error.message = message;
		return error;
	});
	registerRpcError("ApiKeyRequiredError", message => new ApiKeyRequiredError(message));
	registerRpcError("LoginCancelledError", message => new LoginCancelledError(message));
	registerRpcError("OAuthError", message => new OAuthError(message));
	registerRpcError("ConfigurationError", message => new ConfigurationError(message));
	registerRpcError("AuthBrokerError", message => new AuthBrokerError(message));
	registerRpcError("AuthBrokerStreamUnsupportedError", message => new AuthBrokerStreamUnsupportedError(message));
}

function isAuthServiceGlobals(
	value: unknown,
): value is { slowModeLanes: unknown; attachMirrorHost: (host: MirrorHost) => unknown } {
	return (
		typeof value === "object" &&
		value !== null &&
		"slowModeLanes" in value &&
		typeof Reflect.get(value, "attachMirrorHost") === "function"
	);
}

/** Auth, model registry, and slow-mode lane bridging for subagent workers. */
export const authService: ThreadService = {
	name: "auth",

	installMain(peer: WorkerPeer): void {
		registerAuthErrors();
		const link = peer.link;
		link.exportClass<AuthStorage, AuthStorageProtocol>(
			AUTH_STORAGE_KIND,
			(value): value is AuthStorage => value instanceof AuthStorage,
			serveAuthStorage(peerState(link)),
		);
		link.exportClass<ModelRegistry, ModelRegistryProtocol>(
			MODEL_REGISTRY_KIND,
			(value): value is ModelRegistry => value instanceof ModelRegistry,
			serveModelRegistry(peerState(link)),
		);
		link.exportClass<AnthropicSlowModeLanes, SlowModeLanesProtocol>(
			SLOW_MODE_LANES_KIND,
			(value): value is AnthropicSlowModeLanes => value instanceof AnthropicSlowModeLanes,
			{ lane: (lanes, key) => lanes.lane(key) },
		);
		link.exportClass<AnthropicSlowModeController, SlowModeLaneProtocol>(
			SLOW_MODE_LANE_KIND,
			(value): value is AnthropicSlowModeController => value instanceof AnthropicSlowModeController,
			serveSlowModeLane,
		);
	},

	globals(peer: WorkerPeer): AuthServiceGlobals {
		const state = peerState(peer.link);
		return { slowModeLanes: anthropicSlowModeLanes, attachMirrorHost: host => state.mirrorHost.resolve(host) };
	},

	onWorkerExit(peer: WorkerPeer): void {
		peerState(peer.link).release();
	},

	installWorker(link: WorkerThreadLink): void {
		registerAuthErrors();
		link.importClass<AuthStorage, AuthStorageProtocol>(
			AUTH_STORAGE_KIND,
			remote => new AuthStorage(new RemoteAuthStorageBackend(remote)),
		);
		link.importClass<ModelRegistry, ModelRegistryProtocol>(MODEL_REGISTRY_KIND, mirrorModelRegistry);
		link.importClass<RemoteSlowModeLanes, SlowModeLanesProtocol>(
			SLOW_MODE_LANES_KIND,
			remote => new RemoteSlowModeLanes(remote),
		);
		link.importClass<RemoteSlowModeLane, SlowModeLaneProtocol>(
			SLOW_MODE_LANE_KIND,
			remote => new RemoteSlowModeLane(remote),
		);
	},

	boot(globals: unknown): void {
		if (!isAuthServiceGlobals(globals) || !(globals.slowModeLanes instanceof RemoteSlowModeLanes)) {
			throw new Error("auth service: boot globals lack the main thread's slow-mode lanes");
		}
		const lanes = globals.slowModeLanes;
		anthropicSlowModeLanes.useLaneSource(key => lanes.lane(key));
		const host: MirrorHost = registry => {
			// Decoding `registry` built the mirror; composing the catalog now keeps first use cheap.
			prewarmedMirrors.add(registry);
			registry.getAll("all");
			registry.getAvailable("all");
		};
		settleQuietly(globals.attachMirrorHost(host));
	},
};
