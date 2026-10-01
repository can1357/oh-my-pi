import { executeShell } from "@oh-my-pi/pi-natives";
import { $envExact, directoryIsEnterable, getProjectDir, logger, ptree, untilAborted } from "@oh-my-pi/pi-utils";

const COMMAND_TIMEOUT_MS = 10_000;
const COMMAND_FAILURE_RETRY_MS = 30_000;
const INITIAL_MINT_ATTEMPTS = 2;
/** lastGood: stdout of each command's last successful run; a failed run never replaces it. */
const commandResultCache = new Map<string, string>();
/** Failed runs wait this long before another run, preventing a credential-helper storm. */
const commandFailureRetryAt = new Map<string, number>();
/** Why the latest run failed, without retaining command stdout. */
const commandFailure = new Map<string, string>();
/** Commands an ordinary or explicit refresh asked to run; lastGood stays servable if that run fails. */
const commandRefreshPending = new Set<string>();
/** Commands whose cached value a 401 marked: it is not served again until a run succeeds. */
const commandRecoveryPending = new Set<string>();
/** The single shared run per command. */
const commandInFlight = new Map<string, Promise<string | undefined>>();
/** Explicit-invalidation epoch; a run that started under an older generation does not update state. */
const commandGeneration = new Map<string, number>();

type CommandRun = { ok: true; value: string } | { ok: false; failure: string };

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
 * Name a command by its program alone, for diagnostics and logs. Arguments and
 * leading `NAME=value` assignments can carry credentials, so they are elided.
 */
function commandProgram(command: string): string {
	const words = command.split(/\s+/);
	const index = words.findIndex(word => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
	if (index === -1) return "…";
	const program = words[index].replace(/^["']+|["']+$/g, "");
	return words.length > 1 ? `${program} …` : program;
}

/** Withhold a command's cached value while a 401 mark awaits a successful run. */
function handOutValue(command: string, value: string | undefined): string | undefined {
	return commandRecoveryPending.has(command) && value === commandResultCache.get(command) ? undefined : value;
}

/** Invalidate one command-backed value for an ordinary refresh. */
export function invalidateCommandConfig(valueConfig: string | undefined): void {
	if (!isCommandConfigValue(valueConfig)) return;
	const command = commandKey(valueConfig);
	commandRefreshPending.add(command);
	commandFailureRetryAt.delete(command);
	commandInFlight.delete(command);
	commandGeneration.set(command, (commandGeneration.get(command) ?? 0) + 1);
}

/** Mark a command's cached value unservable until a run succeeds. With `sentValue`, only when it is still the cached value. */
export function markCommandConfigForRecovery(valueConfig: string | undefined, sentValue?: string): void {
	if (!isCommandConfigValue(valueConfig)) return;
	const command = commandKey(valueConfig);
	const cached = commandResultCache.get(command);
	if (cached === undefined || (sentValue !== undefined && sentValue !== cached)) return;
	commandRecoveryPending.add(command);
}

/** Invalidate every command-backed value without cancelling shared in-flight processes. */
export function invalidateAllCommandConfigs(): void {
	for (const command of new Set([
		...commandResultCache.keys(),
		...commandFailureRetryAt.keys(),
		...commandInFlight.keys(),
	])) {
		commandRefreshPending.add(command);
		commandFailureRetryAt.delete(command);
		commandGeneration.set(command, (commandGeneration.get(command) ?? 0) + 1);
	}
	commandInFlight.clear();
}

/**
 * Describe why a command-backed value resolves to nothing: the command's
 * program (never its arguments), and how its latest run failed. Undefined once
 * a sendable command value has succeeded, or when the value is not a command.
 */
export function describeCommandConfigFailure(valueConfig: string | undefined): string | undefined {
	if (!isCommandConfigValue(valueConfig)) return undefined;
	const command = commandKey(valueConfig);
	const failure = commandFailure.get(command);
	if (failure === undefined) return undefined;
	if (handOutValue(command, commandResultCache.get(command)) !== undefined) return undefined;
	return `\`${commandProgram(command)}\` ${failure}`;
}

async function executeCommand(valueConfig: string): Promise<string | undefined> {
	const command = commandKey(valueConfig);

	const cached = commandResultCache.get(command);
	if (handOutValue(command, cached) !== undefined && !commandRefreshPending.has(command)) return cached;
	const retryAt = commandFailureRetryAt.get(command);
	if (retryAt !== undefined && Date.now() < retryAt) return handOutValue(command, commandResultCache.get(command));

	const existing = commandInFlight.get(command);
	if (existing) return handOutValue(command, await existing);

	const generation = commandGeneration.get(command) ?? 0;
	const promise: Promise<string | undefined> = (async () => {
		let run: CommandRun = { ok: false, failure: "was not run" };
		let attempts = handOutValue(command, cached) === undefined ? INITIAL_MINT_ATTEMPTS : 1;
		for (let attempt = 0; attempt < attempts; attempt++) {
			run = await runInProjectDir(command);
			if (run.ok) {
				// The helper is authoritative: a successful run clears a 401 mark even
				// when it prints the value that mark withheld.
				if ((commandGeneration.get(command) ?? 0) === generation) {
					commandResultCache.set(command, run.value);
					commandFailureRetryAt.delete(command);
					commandFailure.delete(command);
					commandRefreshPending.delete(command);
					commandRecoveryPending.delete(command);
				}
				return run.value;
			}
			// A 401 may arrive while this mint was in flight. Re-evaluate the
			// state now, then spend one shared replacement attempt if needed.
			if (attempt === 0 && handOutValue(command, commandResultCache.get(command)) === undefined) {
				attempts = INITIAL_MINT_ATTEMPTS;
			}
		}

		const lastGood = commandResultCache.get(command);
		const sendableLastGood = handOutValue(command, lastGood);
		logger.warn("config: !command value resolution failed", {
			command: commandProgram(command),
			failure: run.failure,
			keptPreviousValue: sendableLastGood !== undefined,
			awaitingRecovery: lastGood !== undefined && sendableLastGood === undefined,
		});
		if ((commandGeneration.get(command) ?? 0) === generation) {
			commandFailure.set(command, run.failure);
			commandFailureRetryAt.set(command, Date.now() + COMMAND_FAILURE_RETRY_MS);
		}
		return sendableLastGood;
	})().finally(() => {
		if (commandInFlight.get(command) === promise) commandInFlight.delete(command);
	});

	commandInFlight.set(command, promise);
	return handOutValue(command, await promise);
}

/**
 * Resolve a configuration value. Command values execute asynchronously and
 * cache only successful stdout. A failed run serves the prior stdout through a
 * short backoff; a 401-marked value is not served until the command runs again
 * and succeeds.
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
	return await runShellCommandResult(command, COMMAND_TIMEOUT_MS, cwd);
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
): Promise<string | undefined> {
	const run = await runShellCommandResult(command, timeoutMs, cwd);
	return run.ok ? run.value : undefined;
}

async function runShellCommandResult(command: string, timeoutMs: number, cwd: string): Promise<CommandRun> {
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
	commandFailureRetryAt.clear();
	commandFailure.clear();
	commandRefreshPending.clear();
	commandRecoveryPending.clear();
}
