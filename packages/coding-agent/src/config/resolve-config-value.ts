import { executeShell } from "@oh-my-pi/pi-natives";
import { $envExact, directoryIsEnterable, getProjectDir, logger, ptree, untilAborted } from "@oh-my-pi/pi-utils";

const COMMAND_FAILURE_RETRY_MS = 30_000;
const commandResultCache = new Map<string, string>();
const commandFailureRetryAt = new Map<string, number>();
const commandInFlight = new Map<string, Promise<string | undefined>>();
const commandGeneration = new Map<string, number>();

/** Materialize request headers for models and discovery without property-access side effects. */
export type ConfigHeaderResolver = (signal?: AbortSignal) => Promise<Record<string, string> | undefined>;
/** One raw header layer or previously composed request-time resolver. */
export type ConfigHeaderSource = Record<string, string> | ConfigHeaderResolver | undefined;

/** Optional bearer-header derivation applied after explicitly configured header layers. */
export interface ConfigHeaderResolutionOptions {
	authHeader?: boolean;
	apiKeyConfig?: string;
}

/** Identify command-backed values when collecting credentials that must be invalidated together. */
export function isCommandConfigValue(valueConfig: string | undefined): valueConfig is string {
	return valueConfig?.startsWith("!") === true;
}

function commandKey(valueConfig: string): string {
	return valueConfig.slice(1).trim();
}

/** Invalidate one command-backed value, including its failure backoff and pending cache generation. */
export function invalidateCommandConfig(valueConfig: string | undefined): void {
	if (!isCommandConfigValue(valueConfig)) return;
	const command = commandKey(valueConfig);
	commandResultCache.delete(command);
	commandFailureRetryAt.delete(command);
	commandInFlight.delete(command);
	commandGeneration.set(command, (commandGeneration.get(command) ?? 0) + 1);
}

/** Invalidate every command-backed value without cancelling shared in-flight processes. */
export function invalidateAllCommandConfigs(): void {
	for (const command of new Set([
		...commandResultCache.keys(),
		...commandFailureRetryAt.keys(),
		...commandInFlight.keys(),
	])) {
		commandGeneration.set(command, (commandGeneration.get(command) ?? 0) + 1);
	}
	commandResultCache.clear();
	commandFailureRetryAt.clear();
	commandInFlight.clear();
}

async function executeCommand(valueConfig: string): Promise<string | undefined> {
	const command = commandKey(valueConfig);

	const cached = commandResultCache.get(command);
	if (cached !== undefined) return cached;
	const retryAt = commandFailureRetryAt.get(command);
	if (retryAt !== undefined && Date.now() < retryAt) return undefined;

	const existing = commandInFlight.get(command);
	if (existing) return await existing;

	const generation = commandGeneration.get(command) ?? 0;
	const promise: Promise<string | undefined> = (async () => {
		const cwd = getProjectDir();
		if (!(await directoryIsEnterable(cwd))) return undefined;
		return await runShellCommand(command, 10_000, cwd);
	})()
		.then(result => {
			if ((commandGeneration.get(command) ?? 0) !== generation) return result;
			if (result === undefined) {
				commandFailureRetryAt.set(command, Date.now() + COMMAND_FAILURE_RETRY_MS);
			} else {
				commandFailureRetryAt.delete(command);
				commandResultCache.set(command, result);
			}
			return result;
		})
		.catch(error => {
			const code =
				typeof (error as NodeJS.ErrnoException | null)?.code === "string"
					? (error as NodeJS.ErrnoException).code
					: "unknown";
			logger.warn("config: !command value resolution failed", { code });
			if ((commandGeneration.get(command) ?? 0) === generation) {
				commandFailureRetryAt.set(command, Date.now() + COMMAND_FAILURE_RETRY_MS);
			}
			return undefined;
		})
		.finally(() => {
			if (commandInFlight.get(command) === promise) commandInFlight.delete(command);
		});

	commandInFlight.set(command, promise);
	return await promise;
}

/**
 * Resolve a configuration value. Command values execute asynchronously and
 * successful stdout is cached; environment-backed and literal values stay live.
 */
export async function resolveConfigValue(valueConfig: string): Promise<string | undefined> {
	if (isCommandConfigValue(valueConfig)) return await executeCommand(valueConfig);
	const envValue = $envExact(valueConfig);
	return envValue || valueConfig;
}

/**
 * Run one command-backed value with isolated stdio and a bounded process tree.
 * POSIX uses an absolute shell and a detached process group. Windows keeps
 * Brush's established shell grammar and native process-tree cancellation.
 *
 * The deadline bounds this call on every platform. Reaching it cuts the pipe
 * drains, so the call fails closed. Cleanup reaches a descendant only where
 * ownership is provable: a live root's own tree, the Linux subreaper, or the
 * retained root identity on Windows. On macOS, and on Linux without the
 * subreaper, a descendant that changes session or outlives its root keeps
 * running: `ptree` signals no group id it cannot prove is this command's.
 */
export async function runShellCommand(
	command: string,
	timeoutMs: number,
	cwd: string = getProjectDir(),
): Promise<string | undefined> {
	try {
		if (process.platform === "win32") {
			let output = "";
			const result = await executeShell({ command, cwd, timeoutMs }, (err, chunk) => {
				if (!err) output += chunk;
			});
			if (result.timedOut || result.exitCode !== 0) return undefined;
			const trimmed = output.trim();
			return trimmed.length > 0 ? trimmed : undefined;
		}

		const result = await ptree.exec(["/bin/sh", "-c", command], {
			cwd,
			timeout: timeoutMs,
			allowNonZero: true,
			allowAbort: true,
			detached: true,
			subreaper: process.platform === "linux",
		});
		if (!result.ok || result.exitError?.aborted) return undefined;
		const trimmed = result.stdout.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	} catch {
		return undefined;
	}
}

/** Resolve one raw header record, preserving declaration order and omitting empty values. */
export async function resolveConfigHeaders(
	headers: Record<string, string> | undefined,
	signal?: AbortSignal,
): Promise<Record<string, string> | undefined> {
	signal?.throwIfAborted();
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	let hasResolved = false;
	for (const key in headers) {
		const next = await untilAborted(signal, () => resolveConfigValue(headers[key]));
		if (!next) continue;
		resolved[key] = next;
		hasResolved = true;
	}
	return hasResolved ? resolved : undefined;
}

/**
 * Compose raw config headers and already-composed async header resolvers.
 * Later sources win. The returned resolver materializes a plain record at the
 * request boundary; no property access executes commands.
 */
export function createConfigHeaderResolver(
	sources: readonly ConfigHeaderSource[],
	options?: ConfigHeaderResolutionOptions,
): ConfigHeaderResolver | undefined {
	const active = sources.filter((source): source is Exclude<ConfigHeaderSource, undefined> => source !== undefined);
	if (active.length === 0 && (!options?.authHeader || !options.apiKeyConfig)) return undefined;
	return async signal => {
		signal?.throwIfAborted();
		const resolved: Record<string, string> = {};
		let hasResolved = false;
		for (const source of active) {
			const next =
				typeof source === "function"
					? await untilAborted(signal, () => source(signal))
					: await resolveConfigHeaders(source, signal);
			signal?.throwIfAborted();
			if (!next) continue;
			for (const key in next) {
				resolved[key] = next[key];
				hasResolved = true;
			}
		}
		if (options?.authHeader && options.apiKeyConfig) {
			const keyConfig = options.apiKeyConfig;
			const apiKey = await untilAborted(signal, () => resolveConfigValue(keyConfig));
			if (apiKey) {
				resolved.Authorization = `Bearer ${apiKey}`;
				hasResolved = true;
			}
		}
		return hasResolved ? resolved : undefined;
	};
}

/** Clear all command state. Exported for focused resolver tests. */
export function clearConfigValueCache(): void {
	invalidateAllCommandConfigs();
	commandInFlight.clear();
}
