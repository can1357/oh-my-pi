/**
 * Resolve auth-broker connection configuration for the local omp client.
 *
 * This is a thin coding-agent wrapper around the shared resolver in
 * `@oh-my-pi/pi-ai/auth-broker/discover` that preserves the process-lifetime
 * memoization expected by the CLI and injects the full `resolveConfigValue`
 * (including `!command` config indirection) from coding-agent's config layer.
 *
 * Precedence (highest first):
 *   1. `OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN` env vars.
 *   2. `auth.broker.url` / `auth.broker.token` in `~/.omp/agent/config.yml`
 *      (hidden from the settings UI; `!command` resolution supported).
 *   3. Token file `~/.omp/auth-broker.token` (paired with URL from env or config).
 *
 * Returns null when no broker URL is configured — caller falls back to the
 * local SQLite store.
 *
 * Session discovery takes broker connection values and encryption from the
 * persisted global Settings layer, and account routing from effective Settings.
 */

import * as path from "node:path";
import {
	type AuthAccountPolicyConfig,
	AuthBrokerError,
	loadAuthAccountPolicyConfig,
} from "@oh-my-pi/pi-ai/auth-broker";
import {
	type AuthBrokerClientConfig,
	type AuthBrokerStartupRetry,
	type AuthStoreConfigSnapshot,
	type DiscoverAuthStorageOptions,
	discoverAuthStorage as discoverAuthStorageShared,
	getAuthBrokerTokenFilePath,
	openAuthCredentialStore,
	readAuthStoreConfigSnapshot,
	resolveAuthBrokerConfig as resolveAuthBrokerConfigShared,
	resolveLocalAuthEncryption,
} from "@oh-my-pi/pi-ai/auth-broker/discover";
import type { AuthBrokerProviderPool } from "@oh-my-pi/pi-ai/auth-broker/remote-store";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { MissingApiKeyError } from "@oh-my-pi/pi-ai/error";
import { setUnpausedProviders } from "@oh-my-pi/pi-ai/oauth";
import { providerDeviceBound } from "@oh-my-pi/pi-catalog/compat/auth";
import { getAgentDbPath, getAgentDir, isBunTestRuntime, isInteractiveHost, logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { combine, effectsSettings, type ScopeLike } from "../config/registry";
import { resolveConfigValue } from "../config/resolve-config-value";
import { Settings } from "../config/settings";
import {
	authDaemonStoreKey,
	type ManagedLocalOwnerHooks,
	managedAuth,
	openManagedAuthStorage,
} from "./auth-daemon-backend";
import {
	type AuthDaemonBindingOptions,
	requiresLocalAuthOwnership,
	resolveAuthDaemonBinding,
} from "./auth-daemon-binding";
import type { AuthDaemonBinding } from "./auth-daemon-contract";
import { AuthDaemonBindingError, openAuthDaemonLink } from "./auth-daemon-link";

import { cfgAuthAccountPolicies, cfgOperatorUnpausedProviders } from "../config/model-settings";
import { cfgRetryUsageReservePct } from "./settings";

export { type AuthBrokerClientConfig, getAuthBrokerTokenFilePath };

/** Where auth discovery reads effective settings from; see {@link loadEffectiveAuthAccountPolicyConfig}. */
export interface EffectiveSettingsScope {
	/** Already-resolved settings; wins over every other source. */
	settings?: Settings;
	cwd?: string;
	agentDir?: string;
}

/**
 * Resolve the settings auth discovery must honor: the explicit instance, else the
 * global instance when it targets the same agent dir (and cwd, when given), else a
 * read-only load so `--config`/`PI_CONFIG_FILES`/project overlays still apply.
 */
export async function resolveEffectiveSettings({
	settings,
	cwd,
	agentDir = getAgentDir(),
}: EffectiveSettingsScope = {}): Promise<Settings> {
	if (settings) return settings;
	const current = await Settings.current;
	if (
		current &&
		current.getAgentDir() === path.normalize(agentDir) &&
		(cwd === undefined || current.getCwd() === path.normalize(cwd))
	) {
		return current;
	}
	return Settings.loadReadOnly({ cwd, agentDir });
}

/** Resolve `auth.accountPolicies` + `retry.usageReservePct` from effective settings (SDK discovery, auth-gateway). */
export async function loadEffectiveAuthAccountPolicyConfig(
	scope: EffectiveSettingsScope = {},
): Promise<AuthAccountPolicyConfig> {
	const settings = await resolveEffectiveSettings(scope);
	return loadAuthAccountPolicyConfig({
		accountPolicies: cfgAuthAccountPolicies.get(settings),
		usageReservePct: cfgRetryUsageReservePct.get(settings),
	});
}

/**
 * Process-lifetime memo for {@link resolveAuthBrokerConfig}. Keyed on the env
 * inputs (plus agent dir, which decides which config.yml is read) so tests
 * that flip `OMP_AUTH_BROKER_*` between cases still observe the change, while
 * repeated resolution within one CLI invocation (startup, subagent sessions)
 * skips the config.yml read and any `!command` token resolution.
 */
let cachedConfigKey: string | null = null;
let cachedConfigPromise: Promise<AuthBrokerClientConfig | null> | null = null;

/**
 * Read broker configuration. Returns null when the URL is missing
 * (broker disabled — local store is used). Throws when URL is set but no
 * token is available — the caller cannot fall back silently because the
 * user explicitly asked to use the broker.
 *
 * Successful resolutions (including "no broker configured") are memoized for
 * the process lifetime; failures are not, so a missing token can be fixed and
 * retried. Concurrent callers share one in-flight resolution.
 */
export function resolveAuthBrokerConfig(): Promise<AuthBrokerClientConfig | null> {
	const key = `${process.env.OMP_AUTH_BROKER_URL ?? ""}\u0000${process.env.OMP_AUTH_BROKER_TOKEN ?? ""}\u0000${getAgentDir()}`;
	if (cachedConfigPromise && cachedConfigKey === key) return cachedConfigPromise;
	const promise = resolveAuthBrokerConfigShared({
		agentDir: getAgentDir(),
		configValueResolver: resolveConfigValue,
	});
	cachedConfigKey = key;
	cachedConfigPromise = promise;
	promise.catch(() => {
		if (cachedConfigPromise === promise) {
			cachedConfigPromise = null;
			cachedConfigKey = null;
		}
	});
	return promise;
}

/**
 * Where `provider`'s (credential-store id) logins are stored, for the "Credentials saved to …" /
 * "Credential removed from …" lines after login and logout: the auth broker, or this machine's
 * agent.db without a broker, for a `device-bound` provider, or for a provider the broker would
 * not serve (see `HybridAuthCredentialStore`).
 */
export async function credentialStoreLabel(provider: string, authStorage?: AuthStorage): Promise<string> {
	const managed = authStorage && managedAuth(authStorage);
	if (managed) return managed.credentialDestination(provider);
	const broker = await resolveAuthBrokerConfig();
	if (!broker || providerDeviceBound(provider)) return getAgentDbPath();
	const local = await SqliteAuthCredentialStore.open(getAgentDbPath());
	try {
		return local.listBrokerLocalProviders().includes(provider) ? getAgentDbPath() : `auth broker ${broker.url}`;
	} finally {
		local.close();
	}
}

/** Settings a long-lived auth storage follows (see {@link createAuthStorageSettingsSync}). */
const cfgAuthStorageSettings = combine({
	accountPolicies: cfgAuthAccountPolicies,
	usageReservePct: cfgRetryUsageReservePct,
	unpausedProviders: cfgOperatorUnpausedProviders,
});

/**
 * Applies the operator's `auth.unpausedProviders` (never a project layer's) to this process.
 * The pause set is process-wide: while a settings instance drives effects (`bindEffects`), its
 * effect owns it and other instances leave it alone. Commands that build auth storage from
 * read-only or resolved settings, with nothing bound, call this themselves, or the providers
 * stay paused there. Loaded credential pools refilter on their next read, so order does not matter.
 */
export function applyUnpausedProviders(settings: Settings): void {
	const owner = effectsSettings();
	if (owner !== undefined && owner !== settings) return;
	setUnpausedProviders(cfgOperatorUnpausedProviders.get(settings));
}

/** Live link between settings and a long-lived `AuthStorage`; see {@link createAuthStorageSettingsSync}. */
export interface AuthStorageSettingsSync {
	/** Resolves once every change delivered so far has been applied (or logged as failed). */
	settled(): Promise<void>;
	/** Stops following settings; session scopes stop on dispose without it. */
	stop(): void;
}

/**
 * Keeps a long-lived `authStorage` in step with the auth settings of `scope`:
 * - `auth.accountPolicies` / `retry.usageReservePct` re-apply account routing policy.
 * - `auth.unpausedProviders` (operator layers only) re-applies which paused providers are back
 *   on — loaded credential pools refilter on their next read — and refreshes `modelRegistry`'s
 *   catalog for each newly unpaused provider, as a login does.
 * - `auth.broker.url` / `auth.broker.token` re-resolve the broker with startup
 *   precedence (env → persisted global layer → token file) and swap the
 *   credential store when the effective connection changed.
 *
 * Changes apply in order (broker, then policies, then paused providers within one change); a failing
 * change is logged and leaves the current configuration active.
 */
export function createAuthStorageSettingsSync(
	scope: ScopeLike,
	authStorage: AuthStorage,
	modelRegistry?: Pick<ModelRegistry, "refreshProvider">,
): AuthStorageSettingsSync {
	const settings = "settings" in scope ? scope.settings : scope;
	const agentDir = settings.getAgentDir();
	let configSnapshot = readAuthStoreConfigSnapshot(settings.getGlobalSettings());
	const resolveBroker = (snapshot: AuthStoreConfigSnapshot) =>
		resolveAuthBrokerConfigShared({ agentDir, configSnapshot: snapshot, configValueResolver: resolveConfigValue });
	// A daemon-owned storage follows a change by binding again: the daemon holds the store and
	// its policy view. The new lease serves only once it is bound and holds the session's
	// restrictions and pins; a refused binding leaves the current one in place.
	const managed = managedAuth(authStorage);
	const rebind = async (snapshot: AuthStoreConfigSnapshot) => {
		const bound = (authStorage as SessionAuthStorage)[kBindingOptions];
		await managed?.rebind(
			await resolveAuthDaemonBinding(settings, {
				...bound,
				configSnapshot: snapshot,
				retryUnreachableBroker: false,
			}),
		);
	};
	// Snapshot the connection `authStorage` was opened with, before any edit lands.
	let activeBroker = managed ? Promise.resolve(null) : resolveBroker(configSnapshot).catch(() => null);
	let pending: Promise<void> = Promise.resolve();

	const applyPolicies = async () => {
		try {
			if (managed) await rebind(configSnapshot);
			else authStorage.setAccountPolicies(await loadEffectiveAuthAccountPolicyConfig({ settings }));
		} catch (error) {
			logger.warn("Account policy change not applied; keeping the previous policy", { error: String(error) });
		}
	};

	const applyBroker = async (snapshot: AuthStoreConfigSnapshot) => {
		const previous = await activeBroker;
		try {
			// Standalone CLI helpers still read main YAML; let them see the persisted edit.
			await settings.flush();
			cachedConfigPromise = null;
			cachedConfigKey = null;
			if (managed) {
				await rebind(snapshot);
				logger.info("Daemon auth rebound after broker settings change");
				return;
			}
			const next = await resolveBroker(snapshot);
			if (previous?.url === next?.url && previous?.token === next?.token) return;
			const { store, sourceLabel } = await openAuthCredentialStore({
				brokerConfig: next,
				agentDir,
				encrypt: await resolveLocalAuthEncryption({ configSnapshot: snapshot }),
			});
			await authStorage.replaceStore(store, { sourceLabel });
			activeBroker = Promise.resolve(next);
			logger.info("Auth credential store switched after broker settings change", { source: sourceLabel });
		} catch (error) {
			logger.warn("Auth broker change not applied; keeping the current credential store", {
				error: String(error),
			});
		}
	};

	const applyUnpaused = async (added: readonly string[]) => {
		applyUnpausedProviders(settings);
		if (!modelRegistry) return;
		try {
			await Promise.all(added.map(provider => modelRegistry.refreshProvider(provider, "online")));
		} catch (error) {
			logger.warn("Model list refresh after unpausing a provider failed", { error: String(error) });
		}
	};

	// A global edit is significant even if a project or runtime layer masks it.
	let active = true;
	let queued = false;
	const queueBrokerChange = () => {
		if (queued) return;
		queued = true;
		queueMicrotask(() => {
			queued = false;
			if (!active) return;
			const next = readAuthStoreConfigSnapshot(settings.getGlobalSettings());
			const changed = next.url !== configSnapshot.url || next.token !== configSnapshot.token;
			configSnapshot = next;
			if (changed) pending = pending.then(() => applyBroker(next));
		});
	};
	const stopLayers: Array<() => void> = [];
	for (let layer: Settings | undefined = settings; layer; layer = layer.overlayParent()) {
		stopLayers.push(layer.onLayersChange(queueBrokerChange));
	}

	const stopSettings = cfgAuthStorageSettings.listen(settings, (next, previous) => {
		const policiesChanged =
			next.usageReservePct !== previous.usageReservePct ||
			!Bun.deepEquals(next.accountPolicies, previous.accountPolicies);
		const unpausedChanged = !Bun.deepEquals(next.unpausedProviders, previous.unpausedProviders);
		const unpausedAdded = next.unpausedProviders.filter(provider => !previous.unpausedProviders.includes(provider));
		pending = pending.then(async () => {
			if (policiesChanged) await applyPolicies();
			if (unpausedChanged) await applyUnpaused(unpausedAdded);
		});
		return pending;
	});
	const stop = () => {
		active = false;
		for (const unsubscribe of stopLayers) unsubscribe();
		stopSettings();
	};
	if ("settings" in scope) scope.addDisposer?.(stop);
	return { settled: () => pending, stop };
}

/**
 * Create an AuthStorage instance, using the broker when configured and falling
 * back to the local SQLite store otherwise. Delegates to the shared resolver in
 * pi-ai so the CLI, subagents, and the catalog generator all see the same
 * credentials.
 *
 * Default `agentDir` is the current configured agent directory. Interactive omp
 * fails at once when the broker is unreachable rather than hold the user for the
 * startup retry window; every other host retries and says so once on stderr.
 */
export function discoverAuthStorage(
	agentDir: string = getAgentDir(),
	options?: Omit<DiscoverAuthStorageOptions, "agentDir" | "configValueResolver">,
): Promise<AuthStorage> {
	const interactive = isInteractiveHost();
	return discoverAuthStorageShared({
		retryUnreachableBroker: !interactive,
		onBrokerRetry: interactive ? undefined : authBrokerWaitNotice(),
		...options,
		agentDir,
		configValueResolver: resolveConfigValue,
	});
}

/**
 * Create an AuthStorage instance.
 *
 * Default: local SQLite store at `<agentDir>/agent.db`.
 *
 * Broker mode: when `OMP_AUTH_BROKER_URL` is set, credentials are pulled from
 * a remote auth-broker over the wire. Refresh tokens never leave the broker;
 * the client receives access tokens with `refresh = "__remote__"` and calls
 * back into the broker through the {@link AuthStorageOptions.refreshOAuthCredential}
 * override to re-mint access tokens when needed.
 *
 * Account routing (`auth.accountPolicies`, `retry.usageReservePct`) comes from
 * effective settings: `options.settings` when given, else the matching global
 * instance, else a read-only load for `options.cwd`; explicit option values win.
 */
export async function discoverSessionAuthStorage(
	agentDir?: string,
	options: Omit<DiscoverAuthStorageOptions, "agentDir" | "configValueResolver"> &
		Omit<EffectiveSettingsScope, "agentDir"> = {},
): Promise<AuthStorage> {
	const { settings, cwd, ...discoveryOptions } = options;
	const effective = await resolveEffectiveSettings({ settings, cwd, agentDir });
	applyUnpausedProviders(effective);
	const policy = await loadEffectiveAuthAccountPolicyConfig({ settings: effective });
	return discoverAuthStorage(agentDir ?? effective.getAgentDir(), {
		...discoveryOptions,
		configSnapshot: discoveryOptions.configSnapshot ?? readAuthStoreConfigSnapshot(effective.getGlobalSettings()),
		accountPolicies: discoveryOptions.accountPolicies ?? policy.accountPolicies,
		authStorageOptions: {
			...discoveryOptions.authStorageOptions,
			defaultReservePct: discoveryOptions.authStorageOptions?.defaultReservePct ?? policy.defaultReservePct,
		},
	});
}

/** Binding inputs a daemon-owned storage was opened with; a settings change binds again from them. */
const kBindingOptions = Symbol("auth.bindingOptions");
type SessionAuthStorage = AuthStorage & { [kBindingOptions]?: AuthDaemonBindingOptions };

/** Options of {@link openManagedSessionAuthStorage}. */
export interface ManagedSessionAuthOptions extends Omit<
	DiscoverAuthStorageOptions,
	"agentDir" | "configValueResolver"
> {
	/** Already-resolved broker snapshot cache TTL; omit to consult the environment. */
	snapshotTtlMs?: number;
	/**
	 * Who owns the credential store. Default: the daemon when it offers native auth, otherwise
	 * this process; under the test runtime always this process. `"local"` keeps it here.
	 * `"daemon"` requires the daemon and fails without it.
	 */
	ownership?: "local" | "daemon";
}

/** Open the credential store `binding` names, with nothing re-read from settings or the environment. */
function openBoundCredentialStore(binding: AuthDaemonBinding, agentDir: string) {
	const { broker } = binding;
	let accountPool: Map<string, AuthBrokerProviderPool> | null = null;
	if (broker && broker.accountPool.length > 0) {
		accountPool = new Map();
		for (const { provider, accounts, apiKeys } of broker.accountPool) {
			accountPool.set(provider, { accounts: accounts === undefined ? undefined : new Set(accounts), apiKeys });
		}
	}
	return openAuthCredentialStore({
		brokerConfig: broker && { url: broker.url, token: broker.token },
		agentDir,
		dbPath: binding.dbPath,
		encrypt: binding.encrypt,
		requireUnlocked: true,
		cachePath: broker?.cachePath,
		snapshotTtlMs: broker?.ttlMs,
		accountPool,
		retryUnreachableBroker: false,
	});
}

/**
 * How a daemon-owned storage opens its local owner: a real `AuthStorage` on exactly the store
 * and account policies of the daemon binding. It serves what must run in this process (OAuth
 * login callbacks, extension OAuth providers, MCP grants that need a local secret) and is
 * opened on first such use, never at startup.
 */
export function boundLocalAuthOwner(agentDir: string): ManagedLocalOwnerHooks {
	return {
		async open(binding) {
			const { store, sourceLabel } = await openBoundCredentialStore(binding, agentDir);
			const owner = new AuthStorage(store, {
				accountPolicies: binding.accountPolicies,
				defaultReservePct: binding.defaultReservePct,
				sourceLabel,
				configValueResolver: resolveConfigValue,
			});
			try {
				await owner.credentials.reload();
			} catch (error) {
				owner.close();
				throw error;
			}
			return owner;
		},
		async retarget(owner, binding, previous) {
			if (authDaemonStoreKey(binding) !== authDaemonStoreKey(previous)) {
				const { store, sourceLabel } = await openBoundCredentialStore(binding, agentDir);
				await owner.replaceStore(store, { sourceLabel });
			}
			owner.setAccountPolicies({
				accountPolicies: binding.accountPolicies,
				defaultReservePct: binding.defaultReservePct,
			});
		},
	};
}

/**
 * Create the `AuthStorage` of a stock session (CLI main, SDK without an injected storage).
 *
 * The daemon owns the credential store when it offers native auth: this process binds a
 * private tunnel with its resolved configuration, reads credential metadata once, and never
 * opens or unlocks the store at startup. Stored keys and tokens are requested one at a time.
 *
 * This process owns the store instead (the {@link discoverSessionAuthStorage} path) only for
 * a reason known before binding: `ownership: "local"`, caller auth hooks that cannot cross a
 * process boundary (see `requiresLocalAuthOwnership`), the test runtime, or a daemon without
 * native auth. Once binding was attempted, a refusal or a lost tunnel is an error
 * ({@link AuthDaemonBindingError}); the local store is not a fallback for it.
 *
 * Standalone commands that administer the store keep using {@link discoverSessionAuthStorage}.
 */
export async function openManagedSessionAuthStorage(
	settings: Settings,
	options: ManagedSessionAuthOptions = {},
): Promise<AuthStorage> {
	const { ownership, snapshotTtlMs, ...discovery } = options;
	const bindingOptions: AuthDaemonBindingOptions = { ...discovery, snapshotTtlMs };
	const agentDir = settings.getAgentDir();
	let local: string | undefined;
	if (ownership === "local") local = "requested";
	else if (requiresLocalAuthOwnership(bindingOptions)) local = "caller auth hooks";
	else if (ownership === undefined && isBunTestRuntime()) local = "test runtime";
	if (local === undefined) {
		applyUnpausedProviders(settings);
		const binding = await resolveAuthDaemonBinding(settings, bindingOptions);
		const link = await openAuthDaemonLink(binding);
		if (link) {
			// Bound. From here a failure is an error, never a reason to open the local store.
			const storage: SessionAuthStorage = await openManagedAuthStorage({
				binding,
				link,
				configValueResolver: resolveConfigValue,
				localOwner: boundLocalAuthOwner(agentDir),
			});
			storage[kBindingOptions] = bindingOptions;
			return storage;
		}
		local = "daemon offers no native auth";
	}
	if (ownership === "daemon") throw new Error(`Daemon-owned auth storage is not available: ${local}`);
	logger.debug("Session auth storage is owned by this process", { reason: local });
	return discoverSessionAuthStorage(agentDir, { ...discovery, settings });
}

/** Print the first retry of one startup to stderr; the retry is otherwise only in the log file. */
function authBrokerWaitNotice(): (retry: AuthBrokerStartupRetry) => void {
	let shown = false;
	return ({ url, error, budgetMs }) => {
		if (shown) return;
		shown = true;
		process.stderr.write(
			`Waiting for auth broker at ${url} (${error.message}); retrying for up to ${budgetMs / 1000}s...\n`,
		);
	};
}

/**
 * Turn an auth-storage discovery failure raised at CLI startup into a clean,
 * actionable message, or return `null` when the error is unrelated to the
 * broker (so the caller rethrows it unchanged).
 *
 * A configured broker deliberately *replaces* the local credential store —
 * {@link discoverAuthStorage} never silently falls back to local SQLite once
 * `auth.broker.url` is set — so an unreachable broker is fatal. Without this,
 * the underlying `AuthBrokerError` (or missing-token `MissingApiKeyError`)
 * propagates as a raw uncaught exception and the CLI dies with a stack dump
 * instead of recovery guidance (issue #8096).
 */
export async function describeAuthBrokerStartupError(error: unknown): Promise<string | null> {
	if (error instanceof MissingApiKeyError) {
		// resolveAuthBrokerConfig already built an actionable message naming the
		// env var / config key / token-file path to set.
		return error.message;
	}
	if (error instanceof AuthDaemonBindingError && error.kind !== "broker") {
		return (
			`${error.message}. The omp daemon owns the credential store for this session, ` +
			"and omp will not fall back to opening it directly."
		);
	}
	if (!(error instanceof AuthBrokerError) && !(error instanceof AuthDaemonBindingError)) return null;
	let url: string | undefined;
	try {
		url = (await resolveAuthBrokerConfig())?.url;
	} catch {
		// Config resolution itself failed (e.g. token vanished); fall back to a
		// URL-less message rather than masking the original broker failure.
	}
	const target = url ? ` at ${url}` : "";
	return (
		`Auth broker${target} is unreachable (${error.message}). ` +
		"omp is configured to use this broker for credentials and will not fall back to local credentials automatically.\n" +
		"Start the broker with `omp auth-broker serve`, or disable it with " +
		"`omp config reset auth.broker.url` and `omp config reset auth.broker.token` " +
		"(or unset OMP_AUTH_BROKER_URL / OMP_AUTH_BROKER_TOKEN)."
	);
}
