import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { executeShell } from "@oh-my-pi/pi-natives";
import {
	$envExact,
	directoryIsEnterable,
	expandTilde,
	getProjectDir,
	isFullyQualifiedPath,
	logger,
	ptree,
	untilAborted,
} from "@oh-my-pi/pi-utils";

const COMMAND_FAILURE_RETRY_MS = 30_000;
const commandResultCache = new Map<string, string>();
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

/** Materialize request headers for models and discovery without property-access side effects. */
export type ConfigHeaderResolver = (signal?: AbortSignal) => Promise<Record<string, string> | undefined>;
/** One raw header layer or previously composed request-time resolver. */
export type ConfigHeaderSource = Record<string, string> | ConfigHeaderResolver | undefined;

/** Optional bearer-header derivation applied after explicitly configured header layers. */
export interface ConfigHeaderResolutionOptions {
	authHeader?: boolean;
	apiKeyConfig?: string;
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
 * Normalize the path of a `{ file: <path> }` value: `~/…` (and `~\…` on Windows)
 * expands to the home directory. Returns `undefined` for any path that is not
 * fully qualified after that expansion: a relative path, a bare `~`, and on
 * Windows a drive-relative path (`\secret`, `C:secret`), none of which names
 * one file in every directory and on every drive omp runs from.
 */
export function normalizeFileConfigPath(
	filePath: string,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	const homeRelative = filePath.startsWith("~/") || (platform === "win32" && filePath.startsWith("~\\"));
	const expanded = homeRelative ? expandTilde(filePath) : filePath;
	if (!isFullyQualifiedPath(expanded, platform)) return undefined;
	return (platform === "win32" ? path.win32 : path.posix).normalize(expanded);
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

/**
 * Invalidate one cached value: a `{ file }` value is read again, and a command
 * value loses its cached stdout, failure backoff and pending cache generation.
 */
export function invalidateConfigValue(valueConfig: string | undefined): void {
	if (isFileConfigValue(valueConfig)) {
		fileConfigCache.delete(fileConfigPath(valueConfig));
		return;
	}
	if (!isCommandConfigValue(valueConfig)) return;
	const command = commandKey(valueConfig);
	commandResultCache.delete(command);
	commandFailureRetryAt.delete(command);
	commandInFlight.delete(command);
	commandGeneration.set(command, (commandGeneration.get(command) ?? 0) + 1);
}

/** Invalidate every cached value without cancelling shared in-flight processes. */
export function invalidateAllConfigValues(): void {
	fileConfigCache.clear();
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

function errnoCode(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === "string" ? code : "unknown";
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
 * Resolve a configuration value. Command values execute asynchronously and
 * successful stdout is cached. `{ file }` values are read in-process and re-read
 * when the file changes; an unusable file throws `ConfigurationError`.
 * Environment-backed and literal values stay live.
 */
export async function resolveConfigValue(valueConfig: string): Promise<string | undefined> {
	if (isCommandConfigValue(valueConfig)) return await executeCommand(valueConfig);
	if (isFileConfigValue(valueConfig)) return await resolveFileValue(valueConfig);
	const envValue = $envExact(valueConfig);
	return envValue || valueConfig;
}

/**
 * Run one command-backed value with isolated stdio and a bounded process tree.
 * POSIX uses an absolute shell, a detached process group, and Linux subreaper
 * supervision so descendants cannot survive timeout. Windows runs the command
 * in the embedded bash engine with native process-tree cancellation.
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

/** Clear all command and file state. Exported for focused resolver tests. */
export function clearConfigValueCache(): void {
	invalidateAllConfigValues();
	commandInFlight.clear();
}
