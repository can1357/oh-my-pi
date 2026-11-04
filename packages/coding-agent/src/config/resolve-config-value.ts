import { OAUTH_REFRESH_SKEW_MS } from "@oh-my-pi/pi-ai/auth/refresh";
import { executeShell } from "@oh-my-pi/pi-natives";
import {
	$envExact,
	directoryIsEnterable,
	getProjectDir,
	isRecord,
	logger,
	ptree,
	untilAborted,
} from "@oh-my-pi/pi-utils";

const COMMAND_FAILURE_RETRY_MS = 30_000;
/**
 * Shortest time one successful run is reused before its command may run again. Without it a
 * command printing a JWT already inside the refresh skew would run once per request.
 */
const COMMAND_MIN_REUSE_MS = 30_000;

/** One successful run of a `!command` value. */
interface CommandResult {
	value: string;
	/** `Date.now()` when the run finished. */
	mintedAt: number;
	/** The `exp` claim of a JWT value, in ms. Such a value is never served at or after it. */
	expiresAt: number | undefined;
}

/** Reuse of a value with no discoverable expiry, in ms (`providers.commandRefreshSeconds`); 0 = until invalidated. */
let commandRefreshMs = 0;
const commandResultCache = new Map<string, CommandResult>();
const commandFailureRetryAt = new Map<string, number>();
const commandInFlight = new Map<string, Promise<CommandResult | undefined>>();
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

/**
 * Set how long a `!command` value with no discoverable expiry is reused before its command runs
 * again (setting `providers.commandRefreshSeconds`). Zero, negative or non-finite keeps such a
 * value until a 401 or an explicit credential refresh invalidates it.
 */
export function configureCommandRefreshMs(refreshMs: number): void {
	commandRefreshMs = Number.isFinite(refreshMs) && refreshMs > 0 ? refreshMs : 0;
}

/** The `exp` claim of a JWT value, bare or after an auth scheme such as `Bearer`, in ms. */
function jwtExpiresAt(value: string): number | undefined {
	const match = /^(?:[A-Za-z][\w-]*\s+)?([\w-]+)\.([\w-]+)\.[\w-]*$/.exec(value);
	if (!match) return undefined;
	try {
		const header: unknown = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
		const payload: unknown = JSON.parse(Buffer.from(match[2], "base64url").toString("utf8"));
		if (!isRecord(header) || typeof header.alg !== "string" || !isRecord(payload)) return undefined;
		const exp = payload.exp;
		return typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined;
	} catch {
		return undefined;
	}
}

/**
 * When a result's command may run again. A JWT is re-minted once the OAuth refresh skew before
 * its `exp` is reached, so the next token exists before a provider would reject the old one; any
 * other value after the configured reuse, or never. Never sooner than {@link COMMAND_MIN_REUSE_MS}.
 */
function refreshAt(result: CommandResult): number {
	if (result.expiresAt !== undefined) {
		return Math.max(result.expiresAt - OAUTH_REFRESH_SKEW_MS, result.mintedAt + COMMAND_MIN_REUSE_MS);
	}
	if (commandRefreshMs === 0) return Number.POSITIVE_INFINITY;
	return result.mintedAt + commandRefreshMs;
}

/** A result's value while it may be sent: a JWT never at or after its `exp`. */
function servable(result: CommandResult | undefined, now: number): string | undefined {
	if (result === undefined) return undefined;
	return result.expiresAt === undefined || now < result.expiresAt ? result.value : undefined;
}

async function executeCommand(valueConfig: string): Promise<string | undefined> {
	const command = commandKey(valueConfig);
	const now = Date.now();

	const cached = commandResultCache.get(command);
	if (cached !== undefined && now < refreshAt(cached)) return servable(cached, now);
	// The command is due. Until a run succeeds, the previous value serves while it is still valid.
	const retryAt = commandFailureRetryAt.get(command);
	if (retryAt !== undefined && now < retryAt) return servable(cached, now);

	const existing = commandInFlight.get(command);
	if (existing) return await settle(command, existing);

	const generation = commandGeneration.get(command) ?? 0;
	const promise: Promise<CommandResult | undefined> = (async () => {
		const cwd = getProjectDir();
		if (!(await directoryIsEnterable(cwd))) return undefined;
		return await runShellCommand(command, 10_000, cwd);
	})()
		.then(value => {
			const current = (commandGeneration.get(command) ?? 0) === generation;
			if (value === undefined) {
				if (current) commandFailureRetryAt.set(command, Date.now() + COMMAND_FAILURE_RETRY_MS);
				return undefined;
			}
			const result: CommandResult = { value, mintedAt: Date.now(), expiresAt: jwtExpiresAt(value) };
			if (current) {
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
	return await settle(command, promise);
}

/**
 * Wait for a shared run. A failed run falls back to the previous value while it is still valid,
 * looked up after the run because a 401 during it drops that value.
 */
async function settle(command: string, run: Promise<CommandResult | undefined>): Promise<string | undefined> {
	const result = (await run) ?? commandResultCache.get(command);
	return servable(result, Date.now());
}

/**
 * Resolve a configuration value. Command values execute asynchronously and successful stdout is
 * reused: a JWT until the OAuth refresh skew before its `exp`, any other value for
 * `providers.commandRefreshSeconds` (by default until invalidated). Environment-backed and literal
 * values stay live.
 */
export async function resolveConfigValue(valueConfig: string): Promise<string | undefined> {
	if (isCommandConfigValue(valueConfig)) return await executeCommand(valueConfig);
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

/** Clear all command state. Exported for focused resolver tests. */
export function clearConfigValueCache(): void {
	invalidateAllCommandConfigs();
	commandInFlight.clear();
}
