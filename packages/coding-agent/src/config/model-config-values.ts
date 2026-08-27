import { execSync } from "node:child_process";
import { $envExact, directoryIsEnterableSync, getProjectDir, logger } from "@oh-my-pi/pi-utils";

const commandValueCache = new Map<string, string>();
// Failed `!command` resolutions (non-zero exit, empty stdout) are negative-cached
// with a TTL instead of forever: a transient failure (locked password manager,
// network hiccup) must not disable the key until process restart, but re-running
// the command on every resolution would restore the execSync storm this cache
// exists to prevent. One probe per TTL window bounds both.
const COMMAND_FAILURE_RETRY_MS = 30_000;
const commandFailureRetryAt = new Map<string, number>();

interface ResolveConfigValueOptions {
	forceCommandRefresh?: boolean;
}

export function isCommandConfigValue(valueConfig: string | undefined): valueConfig is string {
	return valueConfig?.startsWith("!") === true;
}

/**
 * Drop the cached result (and any negative-cache backoff) for a command-backed
 * config value so the next {@link resolveConfigValue} re-runs the command.
 *
 * Used by the 401 auth-retry path to force every command-backed credential a
 * provider carries — API key AND header values — to re-mint, not just the
 * apiKey (which alone was covered before). Non-command values are ignored.
 */
export function invalidateCommandConfig(valueConfig: string | undefined): void {
	if (!isCommandConfigValue(valueConfig)) return;
	const command = valueConfig.slice(1).trim();
	commandValueCache.delete(command);
	commandFailureRetryAt.delete(command);
}

function resolveCommandConfig(command: string, options?: ResolveConfigValueOptions): string | undefined {
	if (options?.forceCommandRefresh === true) {
		commandValueCache.delete(command);
		commandFailureRetryAt.delete(command);
	}
	const cached = commandValueCache.get(command);
	if (cached !== undefined) return cached;
	const retryAt = commandFailureRetryAt.get(command);
	if (retryAt !== undefined && Date.now() < retryAt) return undefined;
	try {
		const cwd = getProjectDir();
		if (!directoryIsEnterableSync(cwd)) {
			commandFailureRetryAt.set(command, Date.now() + COMMAND_FAILURE_RETRY_MS);
			return undefined;
		}
		const stdout = execSync(command, {
			cwd,
			encoding: "utf8",
			timeout: 10_000,
			windowsHide: true,
		});
		const trimmed = stdout.trim();
		if (trimmed.length === 0) {
			commandFailureRetryAt.set(command, Date.now() + COMMAND_FAILURE_RETRY_MS);
			return undefined;
		}
		commandFailureRetryAt.delete(command);
		commandValueCache.set(command, trimmed);
		return trimmed;
	} catch (err) {
		// The command may embed credentials inline, and execSync's message can
		// echo the invocation and its output. Log only non-sensitive metadata.
		const code =
			typeof (err as NodeJS.ErrnoException | null)?.code === "string"
				? (err as NodeJS.ErrnoException).code
				: "unknown";
		logger.warn("model-config: !command value resolution failed", { code });
		commandFailureRetryAt.set(command, Date.now() + COMMAND_FAILURE_RETRY_MS);
		return undefined;
	}
}

export interface CommandApiKeyResolution {
	configured: boolean;
	value?: string;
}
/**
 * Resolve a models.yml/models.yaml secret/config value to an actual value.
 * `!cmd` runs a shell command and returns trimmed stdout, otherwise env vars are
 * checked first and the input falls back to a literal value.
 */
export function resolveConfigValue(valueConfig: string, options?: ResolveConfigValueOptions): string | undefined {
	if (valueConfig.startsWith("!")) return resolveCommandConfig(valueConfig.slice(1).trim(), options);
	const envValue = $envExact(valueConfig);
	if (envValue) return envValue;
	return valueConfig;
}

export type HeaderSource = Record<string, string> | undefined;

interface HeaderResolutionOptions {
	authHeader?: boolean;
	apiKeyConfig?: string;
}

function materializeConfigHeaderSources(
	sources: readonly HeaderSource[],
	options?: HeaderResolutionOptions,
): Record<string, string> | undefined {
	const resolved: Record<string, string> = {};
	for (const source of sources) {
		if (!source) continue;
		for (const [key, value] of Object.entries(source)) {
			const next = resolveConfigValue(value);
			if (next) resolved[key] = next;
		}
	}
	if (options?.authHeader && options.apiKeyConfig) {
		const resolvedKey = resolveConfigValue(options.apiKeyConfig);
		if (resolvedKey) resolved.Authorization = `Bearer ${resolvedKey}`;
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export function createLiveConfigHeaders(
	sources: readonly HeaderSource[],
	options?: HeaderResolutionOptions,
): Record<string, string> | undefined {
	const liveSources = sources.filter((source): source is Record<string, string> => source !== undefined);
	if (liveSources.length === 0 && (!options?.authHeader || !options.apiKeyConfig)) return undefined;

	const localHeaders: Record<string, string> = {};
	const allSources = [...liveSources, localHeaders];
	const current = () => materializeConfigHeaderSources(allSources, options) ?? {};
	return new Proxy(localHeaders, {
		get(target, property, receiver) {
			if (typeof property !== "string") return Reflect.get(target, property, receiver);
			return current()[property];
		},
		set(target, property, value) {
			if (typeof property !== "string" || typeof value !== "string") return false;
			target[property] = value;
			return true;
		},
		deleteProperty(target, property) {
			if (typeof property !== "string") return false;
			delete target[property];
			return true;
		},
		has(_target, property) {
			if (typeof property !== "string") return false;
			return Object.hasOwn(current(), property);
		},
		ownKeys() {
			return Reflect.ownKeys(current());
		},
		getOwnPropertyDescriptor(_target, property) {
			if (typeof property !== "string") return undefined;
			const headers = current();
			if (!Object.hasOwn(headers, property)) return undefined;
			return {
				configurable: true,
				enumerable: true,
				value: headers[property],
				writable: true,
			};
		},
	});
}

export function resolveConfigHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	return materializeConfigHeaderSources([headers]);
}
