import { jwtExpiryMs } from "@oh-my-pi/pi-ai/utils/jwt";
import { executeShell } from "@oh-my-pi/pi-natives";
import { $envExact, directoryIsEnterable, getProjectDir, logger, ptree, untilAborted } from "@oh-my-pi/pi-utils";

const COMMAND_FAILURE_RETRY_MS = 30_000;
const commandResultCache = new Map<string, string>();
const commandFailureRetryAt = new Map<string, number>();
const commandInFlight = new Map<string, Promise<string | undefined>>();
const commandGeneration = new Map<string, number>();

/**
 * The one re-mint in flight per command. A credential is shared by every
 * request a session has in the air, so a provider that starts refusing it
 * refuses all of them at once; without this they would each discard the cached
 * value and run the mint again. See {@link remintCommandConfig}.
 */
const commandRemintInFlight = new Map<string, Promise<string | undefined>>();

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
 * The key a command-backed value shares its cached result, its in-flight run
 * and its re-mint under. `!helper` and `! helper` are one command, so callers
 * that compare two configured values — "is this the credential I am already
 * re-minting?" — must compare this and not the raw configuration text.
 */
export function commandConfigKey(valueConfig: string | undefined): string | undefined {
	return isCommandConfigValue(valueConfig) ? commandKey(valueConfig) : undefined;
}

/** Invalidate one command-backed value, including its failure backoff and pending cache generation. */
export function invalidateCommandConfig(valueConfig: string | undefined): void {
	if (!isCommandConfigValue(valueConfig)) return;
	const command = commandKey(valueConfig);
	commandResultCache.delete(command);
	commandFailureRetryAt.delete(command);
	commandInFlight.delete(command);
	commandRemintInFlight.delete(command);
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
	commandRemintInFlight.clear();
}

/**
 * Discard a command-backed value's cached stdout and run the command again,
 * at most once at a time: a caller that asks while a re-mint is in flight
 * joins that one run instead of starting its own. Ten requests sharing one
 * credential, refused together, therefore cost one execution of the mint and
 * ten retries — a mint can be an IAM `generateIdToken` call, and a burst of
 * those per session across a fleet is what this bounds.
 *
 * `rejected` is the credential the refused request actually sent, and it
 * extends that bound past the moment the shared run settles. Refusals of one
 * credential arrive staggered, not only together: a request already on the
 * wire when the mint lands is refused after it, and re-minting again for that
 * refusal costs an issuer call for a credential the caller has in hand. When
 * the cached value is *not* the one the refusal names, the refused request
 * never sent it, so it is returned as-is and nothing is minted.
 *
 * Value identity, not recency, is what makes that safe. "Minted within the
 * last second" would also match a mint that raced the refusal — one issued
 * against the very bytes now cached — and the retry it allowed would be
 * refused again for certain. A cached value that differs from the refused one
 * cannot be the one that refusal names.
 *
 * The reuse is bounded by the cached token's own `exp`, when it states one:
 * past it, the issuer is asked again rather than handing back a credential
 * whose own claim says it is finished. That read decides whether to *mint*,
 * never whether to *send* — a credential is sent until the provider refuses
 * it, which is the signal this whole path is built on.
 *
 * The shared run is decisive for every waiter: a mint that fails resolves them
 * all to `undefined` rather than leaving them waiting, and the entry is
 * dropped as soon as the run settles, so the next refusal starts a fresh
 * attempt instead of joining a dead promise. {@link invalidateCommandConfig}
 * also clears the failure backoff, so a failed re-mint does not park the
 * credential for the backoff window.
 *
 * Callers that merely want the value dropped use
 * {@link invalidateCommandConfig}; this one is for the moment a provider has
 * refused the credential and the fresh value is needed now.
 */
export function remintCommandConfig(valueConfig: string | undefined, rejected?: string): Promise<string | undefined> {
	if (!isCommandConfigValue(valueConfig)) return Promise.resolve(undefined);
	const command = commandKey(valueConfig);
	const joined = commandRemintInFlight.get(command);
	if (joined) return joined;
	const settled = settledMintFor(command, rejected);
	if (settled !== undefined) return Promise.resolve(settled);
	invalidateCommandConfig(valueConfig);
	// `executeCommand` registers its run in `commandInFlight` before its first
	// await, so every later resolve of this command joins it too.
	const started = executeCommand(valueConfig);
	const tracked = started.finally(() => {
		if (commandRemintInFlight.get(command) === tracked) commandRemintInFlight.delete(command);
	});
	commandRemintInFlight.set(command, tracked);
	return tracked;
}

/**
 * The already-minted credential that answers this refusal, or undefined when
 * the issuer has to be asked. See {@link remintCommandConfig}.
 */
function settledMintFor(command: string, rejected: string | undefined): string | undefined {
	if (rejected === undefined) return undefined;
	const cached = commandResultCache.get(command);
	// The refusal names the cached value: this is the mint the provider has
	// already answered, so reusing it would spend the retry on a certainty.
	if (cached === undefined || cached === rejected) return undefined;
	const expiry = jwtExpiryMs(cached);
	return expiry !== undefined && expiry <= Date.now() ? undefined : cached;
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
