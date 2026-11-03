import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { executeShell } from "@oh-my-pi/pi-natives";
import { $envExact, directoryIsEnterable, getProjectDir, logger, ptree, untilAborted } from "@oh-my-pi/pi-utils";

const COMMAND_FAILURE_RETRY_MS = 30_000;
/** Default of the `providers.commandTimeoutSeconds` setting, in milliseconds. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
let commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS;
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
 * Internal spelling of a `{ file: <path> }` config value. Config values travel
 * as strings (auth storage, header records, invalidation sets). A NUL byte can
 * begin no usable literal key, header value or environment variable name, so
 * this prefix cannot collide with a literal, env-var or `!command` value.
 */
const FILE_CONFIG_PREFIX = "\u0000file:";

/** File identity and content of the last successful read of a `{ file }` value. */
interface FileConfigSnapshot {
	mtimeMs: number;
	ctimeMs: number;
	size: number;
	ino: number;
	value: string;
}
const fileConfigCache = new Map<string, FileConfigSnapshot>();

/**
 * Why cached config values are dropped. `rejected`: a 401 proved the value
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
 * A non-positive or non-finite value restores the 10 s default.
 */
export function configureCommandTimeoutMs(timeoutMs: number): void {
	commandTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_COMMAND_TIMEOUT_MS;
}

/** Identify command-backed values. */
export function isCommandConfigValue(valueConfig: string | undefined): valueConfig is string {
	return valueConfig?.startsWith("!") === true;
}

/** Identify `{ file: <path> }` values (see {@link fileConfigValue}). */
export function isFileConfigValue(valueConfig: string | undefined): valueConfig is string {
	return valueConfig?.startsWith(FILE_CONFIG_PREFIX) === true;
}

/**
 * Identify values whose resolved secret is cached, so that a 401 or an explicit
 * refresh must invalidate them together: `!command` and `{ file }` values.
 */
export function isCachedConfigValue(valueConfig: string | undefined): valueConfig is string {
	return isCommandConfigValue(valueConfig) || isFileConfigValue(valueConfig);
}

/**
 * Normalize the path of a `{ file: <path> }` value: `~` and `~/…` expand to the
 * home directory. Returns `undefined` for a relative path, which has no stable
 * meaning across the directories omp runs in.
 */
export function normalizeFileConfigPath(filePath: string): string | undefined {
	const expanded =
		filePath === "~"
			? os.homedir()
			: filePath.startsWith("~/")
				? path.join(os.homedir(), filePath.slice(2))
				: filePath;
	return path.isAbsolute(expanded) ? path.normalize(expanded) : undefined;
}

/** Internal config value that resolves to the trimmed content of the file at an absolute path. */
export function fileConfigValue(absolutePath: string): string {
	return FILE_CONFIG_PREFIX + absolutePath;
}

function fileConfigPath(valueConfig: string): string {
	return valueConfig.slice(FILE_CONFIG_PREFIX.length);
}

function commandKey(valueConfig: string): string {
	return valueConfig.slice(1).trim();
}

function bumpCommandGeneration(command: string): void {
	commandGeneration.set(command, (commandGeneration.get(command) ?? 0) + 1);
}

/** Drop one cached value so the next resolution re-runs its command or re-reads its file. */
export function invalidateConfigValue(valueConfig: string | undefined, reason: ConfigValueInvalidation): void {
	if (isFileConfigValue(valueConfig)) {
		fileConfigCache.delete(fileConfigPath(valueConfig));
		return;
	}
	if (!isCommandConfigValue(valueConfig)) return;
	const command = commandKey(valueConfig);
	commandResultCache.delete(command);
	commandFailureRetryAt.delete(command);
	commandInFlight.delete(command);
	if (reason === "rejected") commandLastGood.delete(command);
	bumpCommandGeneration(command);
}

/** Drop every cached value without cancelling shared in-flight processes. */
export function invalidateAllConfigValues(reason: ConfigValueInvalidation): void {
	fileConfigCache.clear();
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

async function resolveCommandValue(valueConfig: string): Promise<string | undefined> {
	const command = commandKey(valueConfig);
	const cached = commandResultCache.get(command);
	if (cached !== undefined) return cached;
	const lastGood = commandLastGood.get(command);
	const retryAt = commandFailureRetryAt.get(command);
	if (retryAt !== undefined && Date.now() < retryAt) return lastGood;
	const run = commandInFlight.get(command) ?? startCommandRun(command);
	// After a failed run, the retry runs in the background while the last good value serves.
	if (retryAt !== undefined && lastGood !== undefined) return lastGood;
	// A 401 during the run drops the last good value, so read it after the run.
	return (await run) ?? commandLastGood.get(command);
}

function startCommandRun(command: string): Promise<string | undefined> {
	const generation = commandGeneration.get(command) ?? 0;
	const timeoutMs = commandTimeoutMs;
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
 * Ending of every `{ file }` resolution error. The error reaches turn recovery only as
 * assistant-message text, so recovery recognizes it by this suffix (see {@link isFileConfigErrorMessage}).
 */
const FILE_CONFIG_ERROR_SUFFIX = "Fix the file, or the { file: ... } value that names it in models.yml.";

function fileConfigError(filePath: string, problem: string, cause?: unknown): AIError.ConfigurationError {
	return new AIError.ConfigurationError(
		`Config value file ${filePath} ${problem}. ${FILE_CONFIG_ERROR_SUFFIX}`,
		cause === undefined ? undefined : { cause },
	);
}

/**
 * Whether an error message is an unusable `{ file }` key or header. Such a turn is a
 * local configuration error: it is neither retried nor sent down the fallback chain.
 */
export function isFileConfigErrorMessage(message: string | undefined): boolean {
	return message?.includes(FILE_CONFIG_ERROR_SUFFIX) === true;
}

/**
 * Read a `{ file }` value in-process. The content is cached and re-read when the
 * file's mtime, ctime, size or inode changes, or after an invalidation. A
 * missing, unreadable, non-regular or empty file is a configuration error that
 * names the path; retrying cannot fix it.
 */
async function resolveFileValue(valueConfig: string): Promise<string> {
	const filePath = fileConfigPath(valueConfig);
	let stats: Stats;
	try {
		stats = await fs.stat(filePath);
	} catch (error) {
		fileConfigCache.delete(filePath);
		throw fileConfigError(filePath, `could not be read (${errnoCode(error)})`, error);
	}
	if (!stats.isFile()) {
		fileConfigCache.delete(filePath);
		throw fileConfigError(filePath, "is not a regular file");
	}
	const cached = fileConfigCache.get(filePath);
	if (
		cached !== undefined &&
		cached.mtimeMs === stats.mtimeMs &&
		cached.ctimeMs === stats.ctimeMs &&
		cached.size === stats.size &&
		cached.ino === stats.ino
	) {
		return cached.value;
	}
	// Stat before read: a write that lands between them changes the next stat, which re-reads.
	let content: string;
	try {
		content = await fs.readFile(filePath, "utf8");
	} catch (error) {
		fileConfigCache.delete(filePath);
		throw fileConfigError(filePath, `could not be read (${errnoCode(error)})`, error);
	}
	const value = content.trim();
	if (value.length === 0) {
		fileConfigCache.delete(filePath);
		throw fileConfigError(filePath, "is empty");
	}
	fileConfigCache.set(filePath, {
		mtimeMs: stats.mtimeMs,
		ctimeMs: stats.ctimeMs,
		size: stats.size,
		ino: stats.ino,
		value,
	});
	return value;
}

/**
 * Resolve a configuration value. `!command` values run asynchronously; their
 * successful stdout is cached, and a failed re-run serves the last good stdout
 * until a 401 rejects it. `{ file }` values are read in-process and re-read when
 * the file changes; an unusable file throws `ConfigurationError`. Environment
 * variable names and literals stay live.
 */
export async function resolveConfigValue(valueConfig: string): Promise<string | undefined> {
	if (isCommandConfigValue(valueConfig)) return await resolveCommandValue(valueConfig);
	if (isFileConfigValue(valueConfig)) return await resolveFileValue(valueConfig);
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
 * supervision so descendants cannot survive timeout. Windows retains Brush's
 * established shell grammar and native process-tree cancellation. On Linux the
 * time limit also covers the start of the subreaper, a second Bun runtime.
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

/** Clear all command and file state and restore the default command time limit. Exported for focused resolver tests. */
export function clearConfigValueCache(): void {
	invalidateAllConfigValues("rejected");
	commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS;
}
