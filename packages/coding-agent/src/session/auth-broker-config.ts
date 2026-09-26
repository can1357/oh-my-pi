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
 * Broker connection values are read directly from config.yml; account routing
 * policy is loaded from effective Settings by the SDK discovery wrapper.
 */

import * as path from "node:path";
import {
	type AuthAccountPolicyConfig,
	AuthBrokerError,
	loadAuthAccountPolicyConfig,
} from "@oh-my-pi/pi-ai/auth-broker";
import {
	type AuthBrokerClientConfig,
	type DiscoverAuthStorageOptions,
	discoverAuthStorage as discoverAuthStorageShared,
	getAuthBrokerTokenFilePath,
	openAuthCredentialStore,
	resolveAuthBrokerConfig as resolveAuthBrokerConfigShared,
} from "@oh-my-pi/pi-ai/auth-broker/discover";
import { MissingApiKeyError } from "@oh-my-pi/pi-ai/error";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import { combine, type ScopeLike } from "../config/registry";
import { resolveConfigValue } from "../config/resolve-config-value";
import { Settings } from "../config/settings";
import type { AuthStorage } from "./auth-storage";

import { cfgAuthAccountPolicies, cfgAuthBrokerToken, cfgAuthBrokerUrl } from "../config/model-settings";
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
async function resolveEffectiveSettings({ settings, cwd, agentDir = getAgentDir() }: EffectiveSettingsScope) {
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

/** Settings a long-lived auth storage follows (see {@link createAuthStorageSettingsSync}). */
const cfgAuthStorageSettings = combine({
	brokerUrl: cfgAuthBrokerUrl,
	brokerToken: cfgAuthBrokerToken,
	accountPolicies: cfgAuthAccountPolicies,
	usageReservePct: cfgRetryUsageReservePct,
});

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
 * - `auth.broker.url` / `auth.broker.token` flush pending writes, re-resolve the
 *   broker with startup precedence (env → config.yml → token file; project layers
 *   never redirect credentials), and swap the credential store in place when the
 *   effective connection changed — the next credential resolution uses it.
 *
 * Changes apply in order (broker before policies within one change); a failing
 * change is logged and leaves the current configuration active.
 */
export function createAuthStorageSettingsSync(scope: ScopeLike, authStorage: AuthStorage): AuthStorageSettingsSync {
	const settings = "settings" in scope ? scope.settings : scope;
	const agentDir = settings.getAgentDir();
	const resolveOptions = { agentDir, configValueResolver: resolveConfigValue };
	// Snapshot the connection `authStorage` was opened with, before any edit lands.
	let activeBroker: Promise<AuthBrokerClientConfig | null> = resolveAuthBrokerConfigShared(resolveOptions).catch(
		() => null,
	);
	let pending: Promise<void> = Promise.resolve();

	const applyPolicies = async () => {
		try {
			authStorage.setAccountPolicies(await loadEffectiveAuthAccountPolicyConfig({ settings }));
		} catch (error) {
			logger.warn("Account policy change not applied; keeping the previous policy", { error: String(error) });
		}
	};

	const applyBroker = async () => {
		const previous = await activeBroker;
		try {
			// `set()` persists on a debounce; the resolver reads config.yml.
			await settings.flush();
			// Drop the CLI memo so later `resolveAuthBrokerConfig()` callers see the edit.
			cachedConfigPromise = null;
			cachedConfigKey = null;
			const next = await resolveAuthBrokerConfigShared(resolveOptions);
			if (previous?.url === next?.url && previous?.token === next?.token) return;
			const { store, sourceLabel } = await openAuthCredentialStore({ brokerConfig: next, agentDir });
			await authStorage.replaceStore(store, { sourceLabel });
			activeBroker = Promise.resolve(next);
			logger.info("Auth credential store switched after broker settings change", { source: sourceLabel });
		} catch (error) {
			logger.warn("Auth broker change not applied; keeping the current credential store", {
				error: String(error),
			});
		}
	};

	const stop = cfgAuthStorageSettings.listen(scope, (next, previous) => {
		const brokerChanged = next.brokerUrl !== previous.brokerUrl || next.brokerToken !== previous.brokerToken;
		const policiesChanged =
			next.usageReservePct !== previous.usageReservePct ||
			!Bun.deepEquals(next.accountPolicies, previous.accountPolicies);
		pending = pending.then(async () => {
			if (brokerChanged) await applyBroker();
			if (policiesChanged) await applyPolicies();
		});
		return pending;
	});
	return { settled: () => pending, stop };
}

/**
 * Create an AuthStorage instance, using the broker when configured and falling
 * back to the local SQLite store otherwise. Delegates to the shared resolver in
 * pi-ai so the CLI, subagents, and the catalog generator all see the same
 * credentials.
 *
 * Default `agentDir` is the current configured agent directory.
 */
export function discoverAuthStorage(
	agentDir: string = getAgentDir(),
	options?: Omit<DiscoverAuthStorageOptions, "agentDir" | "configValueResolver">,
): Promise<AuthStorage> {
	return discoverAuthStorageShared({
		...options,
		agentDir,
		configValueResolver: resolveConfigValue,
	});
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
 *
 * A broker that answered 401/403 is reachable but rejected the bearer token
 * (rotated with `omp auth-broker token --regenerate`, or a stale
 * `auth.broker.token`), so that case points at replacing the token rather
 * than at starting the broker.
 */
export async function describeAuthBrokerStartupError(error: unknown): Promise<string | null> {
	if (error instanceof MissingApiKeyError) {
		// resolveAuthBrokerConfig already built an actionable message naming the
		// env var / config key / token-file path to set.
		return error.message;
	}
	if (!(error instanceof AuthBrokerError)) return null;
	let url: string | undefined;
	try {
		url = (await resolveAuthBrokerConfig())?.url;
	} catch {
		// Config resolution itself failed (e.g. token vanished); fall back to a
		// URL-less message rather than masking the original broker failure.
	}
	const target = url ? ` at ${url}` : "";
	const disable =
		"disable it with `omp config reset auth.broker.url` and `omp config reset auth.broker.token` " +
		"(or unset OMP_AUTH_BROKER_URL / OMP_AUTH_BROKER_TOKEN).";
	if (error.kind === "unauthorized") {
		return (
			`Auth broker${target} is reachable but rejected the configured bearer token (${error.message}). ` +
			"omp is configured to use this broker for credentials and will not fall back to local credentials automatically.\n" +
			"Print the broker's current token with `omp auth-broker token` on the broker host and set it via " +
			`OMP_AUTH_BROKER_TOKEN, the \`auth.broker.token\` config entry, or ${getAuthBrokerTokenFilePath()}; or ${disable}`
		);
	}
	return (
		`Auth broker${target} is unreachable (${error.message}). ` +
		"omp is configured to use this broker for credentials and will not fall back to local credentials automatically.\n" +
		`Start the broker with \`omp auth-broker serve\`, or ${disable}`
	);
}
