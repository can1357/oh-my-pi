import { executeShell } from "@oh-my-pi/pi-natives";
import { $envExact, directoryIsEnterable, getProjectDir, logger, ptree, untilAborted } from "@oh-my-pi/pi-utils";
import { effectsSettings } from "./registry";

const COMMAND_FAILURE_RETRY_MS = 30_000;
/** Default of the `providers.commandTimeoutSeconds` setting, in milliseconds. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
/** Set by the `providers.commandTimeoutSeconds` effect of the settings that drive effects. */
let commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS;
/**
 * Reads the `!command` time limit of ONE resolution or storage operation, from
 * the settings that operation belongs to. Carried by the operation (see
 * {@link resolveConfigValue}), never installed process-wide: two scopes that
 * resolve credentials in one process each keep their own limit.
 */
export type CommandTimeoutSource = () => number;
/** Fresh stdout, served without re-running the command until it is invalidated. */
const commandResultCache = new Map<string, string>();
/**
 * The last stdout each command produced. When a re-run fails, resolution keeps
 * serving it and retries the command in the background, until a 401 rejects it.
 */
const commandLastGood = new Map<string, string>();
const commandFailureRetryAt = new Map<string, number>();
const commandInFlight = new Map<string, Promise<string | undefined>>();
const commandGeneration = new Map<string, number>();

/**
 * Why cached command values are dropped. `rejected`: a 401 proved the value
 * stale, so a command's last good value goes too. `refresh`: the user asked for
 * a re-mint (`omp models refresh`, F5); a failing re-run still serves the last
 * good value.
 */
export type ConfigValueInvalidation = "rejected" | "refresh";

type CommandOutcome =
	| { ok: true; value: string }
	| {
			ok: false;
			reason: "timeout" | "killed" | "exit" | "empty" | "spawn" | "cwd-unavailable";
			exitCode?: number | null;
			code?: string;
	  };

/** Materialize request headers for models and discovery without property-access side effects. */
export type ConfigHeaderResolver = (signal?: AbortSignal) => Promise<Record<string, string> | undefined>;
/** One raw header layer or previously composed request-time resolver. */
export type ConfigHeaderSource = Record<string, string> | ConfigHeaderResolver | undefined;

/** Optional bearer-header derivation applied after explicitly configured header layers. */
export interface ConfigHeaderResolutionOptions {
	authHeader?: boolean;
	apiKeyConfig?: string;
}

/**
 * Set the time limit of each `!command` run (setting `providers.commandTimeoutSeconds`).
 * A non-positive or non-finite value restores the 10 s default. The settings
 * effect calls this for the settings instance that drives effects.
 */
export function configureCommandTimeoutMs(timeoutMs: number): void {
	commandTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_COMMAND_TIMEOUT_MS;
}

/**
 * The limit of a run starting now. Settings that drive effects (`Settings.init`,
 * an SDK session's `bindEffects`) own the process, so their limit wins; otherwise
 * the operation's own source decides, and a process with neither keeps the default.
 */
function commandTimeoutMsFor(source: CommandTimeoutSource | undefined): number {
	if (effectsSettings() !== undefined || source === undefined) return commandTimeoutMs;
	const timeoutMs = source();
	return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_COMMAND_TIMEOUT_MS;
}

/** Identify command-backed values when collecting credentials that must be invalidated together. */
export function isCommandConfigValue(valueConfig: string | undefined): valueConfig is string {
	return valueConfig?.startsWith("!") === true;
}

function commandKey(valueConfig: string): string {
	return valueConfig.slice(1).trim();
}

function bumpCommandGeneration(command: string): void {
	commandGeneration.set(command, (commandGeneration.get(command) ?? 0) + 1);
}

/** Invalidate one command-backed value, including its failure backoff and pending cache generation. */
export function invalidateCommandConfig(valueConfig: string | undefined, reason: ConfigValueInvalidation): void {
	if (!isCommandConfigValue(valueConfig)) return;
	const command = commandKey(valueConfig);
	commandResultCache.delete(command);
	commandFailureRetryAt.delete(command);
	commandInFlight.delete(command);
	if (reason === "rejected") commandLastGood.delete(command);
	bumpCommandGeneration(command);
}

/** Invalidate every command-backed value without cancelling shared in-flight processes. */
export function invalidateAllCommandConfigs(reason: ConfigValueInvalidation): void {
	for (const command of new Set([
		...commandResultCache.keys(),
		...commandFailureRetryAt.keys(),
		...commandInFlight.keys(),
		...commandLastGood.keys(),
	])) {
		bumpCommandGeneration(command);
	}
	commandResultCache.clear();
	commandFailureRetryAt.clear();
	commandInFlight.clear();
	if (reason === "rejected") commandLastGood.clear();
}

function errnoCode(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === "string" ? code : "unknown";
}

async function resolveCommandValue(
	valueConfig: string,
	commandTimeout: CommandTimeoutSource | undefined,
): Promise<string | undefined> {
	const command = commandKey(valueConfig);
	const cached = commandResultCache.get(command);
	if (cached !== undefined) return cached;
	const lastGood = commandLastGood.get(command);
	const retryAt = commandFailureRetryAt.get(command);
	if (retryAt !== undefined && Date.now() < retryAt) return lastGood;
	const generation = commandGeneration.get(command) ?? 0;
	const run = commandInFlight.get(command) ?? startCommandRun(command, commandTimeoutMsFor(commandTimeout));
	// After a failed run, the retry runs in the background while the last good value serves.
	if (retryAt !== undefined && lastGood !== undefined) return lastGood;
	const value = await run;
	// An invalidation while the run was in flight (a 401, an explicit refresh) made its
	// output stale: resolve again instead of handing the old value to this waiter.
	if ((commandGeneration.get(command) ?? 0) !== generation) return resolveCommandValue(valueConfig, commandTimeout);
	// A 401 during the run drops the last good value, so read it after the run.
	return value ?? commandLastGood.get(command);
}

function startCommandRun(command: string, timeoutMs: number): Promise<string | undefined> {
	const generation = commandGeneration.get(command) ?? 0;
	const startedAt = performance.now();
	const promise: Promise<string | undefined> = runConfigCommand(command, timeoutMs)
		.then(outcome => {
			const current = (commandGeneration.get(command) ?? 0) === generation;
			if (outcome.ok) {
				if (current) {
					commandFailureRetryAt.delete(command);
					commandResultCache.set(command, outcome.value);
					commandLastGood.set(command, outcome.value);
				}
				return outcome.value;
			}
			// Never log the command: its arguments can carry tokens.
			logger.warn("config: !command value resolution failed", {
				reason: outcome.reason,
				exitCode: outcome.exitCode,
				code: outcome.code,
				elapsedMs: Math.round(performance.now() - startedAt),
				timeoutMs,
				servingLastGoodValue: current && commandLastGood.has(command),
			});
			if (current) commandFailureRetryAt.set(command, Date.now() + COMMAND_FAILURE_RETRY_MS);
			return undefined;
		})
		.finally(() => {
			if (commandInFlight.get(command) === promise) commandInFlight.delete(command);
		});
	commandInFlight.set(command, promise);
	return promise;
}

async function runConfigCommand(command: string, timeoutMs: number): Promise<CommandOutcome> {
	try {
		const cwd = getProjectDir();
		if (!(await directoryIsEnterable(cwd))) return { ok: false, reason: "cwd-unavailable" };
		return await runShellCommandOutcome(command, timeoutMs, cwd);
	} catch (error) {
		return { ok: false, reason: "spawn", code: errnoCode(error) };
	}
}

/**
 * Resolve a configuration value. Command values execute asynchronously; their
 * successful stdout is cached, and a failed re-run serves the last good stdout
 * until a 401 rejects it. Environment-backed and literal values stay live.
 *
 * `commandTimeout` is the time limit of THIS operation, read from the settings
 * the caller is resolving for. A caller with settings in hand binds it once (see
 * `session/auth-broker-config.ts`) so two scopes in one process never inherit
 * each other's limit; settings that drive effects still win over it.
 */
export async function resolveConfigValue(
	valueConfig: string,
	commandTimeout?: CommandTimeoutSource,
): Promise<string | undefined> {
	if (isCommandConfigValue(valueConfig)) return await resolveCommandValue(valueConfig, commandTimeout);
	const envValue = $envExact(valueConfig);
	return envValue || valueConfig;
}

function trimmedOutcome(output: string): CommandOutcome {
	const trimmed = output.trim();
	return trimmed.length > 0 ? { ok: true, value: trimmed } : { ok: false, reason: "empty" };
}

async function runShellCommandOutcome(command: string, timeoutMs: number, cwd: string): Promise<CommandOutcome> {
	try {
		if (process.platform === "win32") {
			let output = "";
			const result = await executeShell({ command, cwd, timeoutMs }, (err, chunk) => {
				if (!err) output += chunk;
			});
			if (result.timedOut) return { ok: false, reason: "timeout" };
			if (result.exitCode !== 0) return { ok: false, reason: "exit", exitCode: result.exitCode ?? null };
			return trimmedOutcome(output);
		}

		const result = await ptree.exec(["/bin/sh", "-c", command], {
			cwd,
			timeout: timeoutMs,
			allowNonZero: true,
			allowAbort: true,
			detached: true,
			subreaper: process.platform === "linux",
		});
		if (result.exitError?.aborted) {
			return {
				ok: false,
				reason: result.exitError instanceof ptree.TimeoutError ? "timeout" : "killed",
				exitCode: result.exitCode,
			};
		}
		if (!result.ok) return { ok: false, reason: "exit", exitCode: result.exitCode };
		return trimmedOutcome(result.stdout);
	} catch (error) {
		return { ok: false, reason: "spawn", code: errnoCode(error) };
	}
}

/**
 * Run one command-backed value with isolated stdio and a bounded process tree.
 * POSIX uses an absolute shell, a detached process group, and Linux subreaper
 * supervision so descendants cannot survive timeout. Windows runs the command
 * in the embedded bash engine with native process-tree cancellation. On Linux
 * the time limit also covers the start of the subreaper, a second Bun runtime.
 */
export async function runShellCommand(
	command: string,
	timeoutMs: number,
	cwd: string = getProjectDir(),
): Promise<string | undefined> {
	const outcome = await runShellCommandOutcome(command, timeoutMs, cwd);
	return outcome.ok ? outcome.value : undefined;
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

/** Clear all command state and restore the default command time limit. Exported for focused resolver tests. */
export function clearConfigValueCache(): void {
	invalidateAllCommandConfigs("rejected");
	commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS;
}
