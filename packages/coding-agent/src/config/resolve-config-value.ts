import { executeShell } from "@oh-my-pi/pi-natives";
import { $envExact, directoryIsEnterable, getProjectDir, logger, ptree, untilAborted } from "@oh-my-pi/pi-utils";

const COMMAND_TIMEOUT_MS = 10_000;
/** Last stdout each command printed on success; a failed run never replaces it. */
const commandResultCache = new Map<string, string>();
/** Commands whose cached stdout was invalidated and must be re-run before it is trusted again. */
const commandStale = new Set<string>();
/** Why the latest run failed, for commands that have never succeeded. */
const commandFailure = new Map<string, string>();
const commandInFlight = new Map<string, Promise<string | undefined>>();
const commandGeneration = new Map<string, number>();

/** One `!command` run: its trimmed stdout, or why it produced none. */
export type CommandRun = { ok: true; value: string } | { ok: false; failure: string };

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

/**
 * Invalidate one command-backed value: its next resolve re-runs the command.
 * The previous stdout stays as the fallback for a failed re-run.
 */
export function invalidateCommandConfig(valueConfig: string | undefined): void {
	if (!isCommandConfigValue(valueConfig)) return;
	const command = commandKey(valueConfig);
	if (commandResultCache.has(command)) commandStale.add(command);
	commandInFlight.delete(command);
	commandGeneration.set(command, (commandGeneration.get(command) ?? 0) + 1);
}

/** Invalidate every command-backed value without cancelling shared in-flight processes. */
export function invalidateAllCommandConfigs(): void {
	for (const command of new Set([...commandResultCache.keys(), ...commandInFlight.keys()])) {
		commandGeneration.set(command, (commandGeneration.get(command) ?? 0) + 1);
	}
	for (const command of commandResultCache.keys()) commandStale.add(command);
	commandInFlight.clear();
}

/**
 * Describe why a command-backed value resolves to nothing: the command, and how
 * its latest run failed. Undefined once the command has succeeded, or when the
 * value is not a command.
 */
export function describeCommandConfigFailure(valueConfig: string | undefined): string | undefined {
	if (!isCommandConfigValue(valueConfig)) return undefined;
	const command = commandKey(valueConfig);
	const failure = commandFailure.get(command);
	return failure === undefined ? undefined : `\`${command}\` ${failure}`;
}

async function executeCommand(valueConfig: string): Promise<string | undefined> {
	const command = commandKey(valueConfig);

	const cached = commandResultCache.get(command);
	if (cached !== undefined && !commandStale.has(command)) return cached;

	const existing = commandInFlight.get(command);
	if (existing) return await existing;

	const generation = commandGeneration.get(command) ?? 0;
	const promise: Promise<string | undefined> = (async () => {
		const run = await runInProjectDir(command);
		const current = (commandGeneration.get(command) ?? 0) === generation;
		if (run.ok) {
			if (current) {
				commandResultCache.set(command, run.value);
				commandStale.delete(command);
				commandFailure.delete(command);
			}
			return run.value;
		}
		// A failed run is never cached: the next resolve runs the command again,
		// and until one succeeds the previous stdout (if any) stands in for it.
		const previous = commandResultCache.get(command);
		logger.warn("config: !command value resolution failed", {
			failure: run.failure,
			keptPreviousValue: previous !== undefined,
		});
		if (current && previous === undefined) commandFailure.set(command, run.failure);
		return previous;
	})().finally(() => {
		if (commandInFlight.get(command) === promise) commandInFlight.delete(command);
	});

	commandInFlight.set(command, promise);
	return await promise;
}

/**
 * Resolve a configuration value. Command values execute asynchronously and
 * successful stdout is cached; a failed run returns the previous stdout, or
 * undefined when the command has never succeeded, and is retried on the next
 * resolve. Environment-backed and literal values stay live.
 */
export async function resolveConfigValue(valueConfig: string): Promise<string | undefined> {
	if (isCommandConfigValue(valueConfig)) return await executeCommand(valueConfig);
	const envValue = $envExact(valueConfig);
	return envValue || valueConfig;
}

/** Run a command-backed value in the project directory, which must be enterable. */
async function runInProjectDir(command: string): Promise<CommandRun> {
	let cwd: string;
	try {
		cwd = getProjectDir();
	} catch (error) {
		return { ok: false, failure: `was not run: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!(await directoryIsEnterable(cwd))) {
		return { ok: false, failure: "was not run: the working directory cannot be entered" };
	}
	return await runShellCommand(command, COMMAND_TIMEOUT_MS, cwd);
}

/**
 * Run one command-backed value with isolated stdio and a bounded process tree.
 * POSIX uses an absolute shell, a detached process group, and Linux subreaper
 * supervision so descendants cannot survive timeout. Windows retains Brush's
 * established shell grammar and native process-tree cancellation.
 */
export async function runShellCommand(
	command: string,
	timeoutMs: number,
	cwd: string = getProjectDir(),
): Promise<CommandRun> {
	try {
		if (process.platform === "win32") {
			let output = "";
			const result = await executeShell({ command, cwd, timeoutMs }, (err, chunk) => {
				if (!err) output += chunk;
			});
			if (result.timedOut) return timedOutRun(timeoutMs);
			return completedRun(result.exitCode, output);
		}

		const result = await ptree.exec(["/bin/sh", "-c", command], {
			cwd,
			timeout: timeoutMs,
			allowNonZero: true,
			allowAbort: true,
			detached: true,
			subreaper: process.platform === "linux",
		});
		if (result.exitError instanceof ptree.TimeoutError) return timedOutRun(timeoutMs);
		if (result.exitError?.aborted) return { ok: false, failure: "was killed before it finished" };
		return completedRun(result.exitCode, result.stdout);
	} catch (error) {
		const code =
			typeof (error as NodeJS.ErrnoException | null)?.code === "string"
				? (error as NodeJS.ErrnoException).code
				: "unknown";
		return { ok: false, failure: `could not be started (${code})` };
	}
}

function timedOutRun(timeoutMs: number): CommandRun {
	return { ok: false, failure: `timed out after ${timeoutMs / 1000} s` };
}

function completedRun(exitCode: number | null | undefined, stdout: string): CommandRun {
	if (exitCode !== 0) return { ok: false, failure: `exited with status ${exitCode ?? "unknown"}` };
	const value = stdout.trim();
	return value.length > 0 ? { ok: true, value } : { ok: false, failure: "exited with status 0 but printed nothing" };
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
	commandResultCache.clear();
	commandStale.clear();
	commandFailure.clear();
}
