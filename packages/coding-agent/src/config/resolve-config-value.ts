import { executeShell } from "@oh-my-pi/pi-natives";
import { $envExact, directoryIsEnterable, getProjectDir, logger, ptree, untilAborted } from "@oh-my-pi/pi-utils";

const COMMAND_FAILURE_RETRY_MS = 30_000;

/**
 * One command's cached stdout and the generation of the mint that produced it.
 *
 * Two runs of an issuer can hand back byte-identical credentials, so the bytes
 * cannot say which run produced the copy a request sent. The generation can:
 * it counts this command's mints, monotonically, and never repeats.
 */
interface CommandCredential {
	value: string;
	generation: number;
}

const commandResultCache = new Map<string, CommandCredential>();
const commandFailureRetryAt = new Map<string, number>();
const commandInFlight = new Map<string, Promise<CommandCredential | undefined>>();
/** Bumped by every invalidation, so a run that started before one cannot cache its result. */
const commandInvalidationEpoch = new Map<string, number>();
/** The last generation handed out per command; monotonic, and never reset by invalidation. */
const commandMintedGeneration = new Map<string, number>();
/**
 * The highest generation of a command's credential a provider has refused.
 *
 * A refusal names the generation whose bytes its request sent, so this is the
 * watermark below which no cached credential may answer a later refusal: the
 * generation the provider has already answered, and every older copy.
 */
const commandRefusedGeneration = new Map<string, number>();

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

/** Effective raw header values retained through composed resolvers. */
const headerConfigs = new WeakMap<ConfigHeaderResolver, Record<string, string>>();

/** Snapshot only the command slots this header chain actually materializes. */
export function configHeaderGenerations(
	resolver: ConfigHeaderResolver | undefined,
): Record<string, number> | undefined {
	const configs = resolver && headerConfigs.get(resolver);
	if (!configs) return undefined;
	let generations: Record<string, number> | undefined;
	for (const config of Object.values(configs)) {
		const command = commandConfigKey(config);
		if (command === undefined) continue;
		const cached = commandResultCache.get(command);
		if (cached) (generations ??= {})[`!${command}`] = cached.generation;
	}
	return generations;
}

/** Whether a non-minting recovery can still serve this command's cached slot. */
export function hasUnrefusedCommandCredential(valueConfig: string | undefined): boolean {
	return !isCommandConfigValue(valueConfig) || settledMintFor(commandKey(valueConfig)) !== undefined;
}

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

/** Invalidate one command-backed value, including its failure backoff and pending cache epoch. */
export function invalidateCommandConfig(valueConfig: string | undefined): void {
	if (!isCommandConfigValue(valueConfig)) return;
	const command = commandKey(valueConfig);
	commandResultCache.delete(command);
	commandFailureRetryAt.delete(command);
	commandInFlight.delete(command);
	commandRemintInFlight.delete(command);
	commandInvalidationEpoch.set(command, (commandInvalidationEpoch.get(command) ?? 0) + 1);
}

/** Invalidate every command-backed value without cancelling shared in-flight processes. */
export function invalidateAllCommandConfigs(): void {
	for (const command of new Set([
		...commandResultCache.keys(),
		...commandFailureRetryAt.keys(),
		...commandInFlight.keys(),
	])) {
		commandInvalidationEpoch.set(command, (commandInvalidationEpoch.get(command) ?? 0) + 1);
	}
	commandResultCache.clear();
	commandFailureRetryAt.clear();
	commandInFlight.clear();
	commandRemintInFlight.clear();
}

/**
 * Record that the provider refused the credential of `generation`.
 *
 * This is the only fact that disqualifies a minted credential. A provider
 * refusing a generation is the whole of it: no clock is consulted, and no
 * claim the credential makes about its own lifetime is read. A client has no
 * trusted clock, and one running fast turned a wave of refusals into one mint
 * per refusal and threw away replacements the provider was accepting.
 */
export function refuseCommandGeneration(valueConfig: string | undefined, generation: number | undefined): void {
	if (generation === undefined || !isCommandConfigValue(valueConfig)) return;
	const command = commandKey(valueConfig);
	const refused = commandRefusedGeneration.get(command);
	if (refused === undefined || generation > refused) commandRefusedGeneration.set(command, generation);
}

/**
 * Discard a command-backed value's cached stdout and run the command again,
 * at most once at a time: a caller that asks while a re-mint is in flight
 * joins that one run instead of starting its own. Ten requests sharing one
 * credential, refused together, therefore cost one execution of the mint and
 * ten retries — a mint can be an IAM `generateIdToken` call, and a burst of
 * those per session across a fleet is what this bounds.
 *
 * `rejectedGeneration` is the generation of the credential the refused request
 * sent, and it extends that bound past the moment the shared run settles.
 * Refusals of one credential arrive staggered, not only together: a request
 * already on the wire when the mint lands is refused after it, and minting
 * again for that refusal costs an issuer call for a credential the caller has
 * in hand. A mint that came *after* the generation a refusal names, and that
 * no provider has refused in its turn, answers it; nothing is minted.
 *
 * Ordering, not bytes, is what makes that safe. An issuer may hand back the
 * same bytes twice, so "the cached value differs from the refused one" cannot
 * tell a request's own credential from its replacement, and a wave of
 * refusals that straddled a settlement cost one mint each. Generations are
 * monotonic per command, so `cached > refused` is exactly "minted after the
 * refusal that is asking, and not itself refused since".
 *
 * A refusal that cannot name its generation — a caller outside the resolve
 * path, or a bearer the command never produced — proves nothing about what
 * the cache holds, so it mints.
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
export function remintCommandConfig(
	valueConfig: string | undefined,
	rejectedGeneration?: number,
): Promise<string | undefined> {
	if (!isCommandConfigValue(valueConfig)) return Promise.resolve(undefined);
	const command = commandKey(valueConfig);
	refuseCommandGeneration(valueConfig, rejectedGeneration);
	const joined = commandRemintInFlight.get(command);
	if (joined) return joined;
	if (rejectedGeneration !== undefined) {
		const settled = settledMintFor(command);
		if (settled !== undefined) return Promise.resolve(settled);
	}
	invalidateCommandConfig(valueConfig);
	// `executeCommand` registers its run in `commandInFlight` before its first
	// await, so every later resolve of this command joins it too.
	const started = executeCommand(valueConfig).then(credential => credential?.value);
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
function settledMintFor(command: string): string | undefined {
	const cached = commandResultCache.get(command);
	if (cached === undefined) return undefined;
	// Every generation up to the watermark has been refused — including the one
	// this refusal names, recorded a moment ago. Handing one of them back would
	// spend the retry on a certainty.
	const refused = commandRefusedGeneration.get(command) ?? 0;
	return cached.generation > refused ? cached.value : undefined;
}

async function executeCommand(valueConfig: string): Promise<CommandCredential | undefined> {
	const command = commandKey(valueConfig);

	const cached = commandResultCache.get(command);
	if (cached !== undefined && cached.generation > (commandRefusedGeneration.get(command) ?? 0)) return cached;
	const retryAt = commandFailureRetryAt.get(command);
	if (retryAt !== undefined && Date.now() < retryAt) return undefined;

	const existing = commandInFlight.get(command);
	if (existing) return await existing;

	const epoch = commandInvalidationEpoch.get(command) ?? 0;
	const promise: Promise<CommandCredential | undefined> = (async () => {
		const cwd = getProjectDir();
		if (!(await directoryIsEnterable(cwd))) return undefined;
		return await runShellCommand(command, 10_000, cwd);
	})()
		.then(result => {
			if (result === undefined) {
				if ((commandInvalidationEpoch.get(command) ?? 0) === epoch) {
					commandFailureRetryAt.set(command, Date.now() + COMMAND_FAILURE_RETRY_MS);
				}
				return undefined;
			}
			// A run the cache no longer owns still produced a credential its
			// caller will send, so it gets a generation of its own; what it must
			// not do is overwrite the entry the invalidation made room for.
			const generation = (commandMintedGeneration.get(command) ?? 0) + 1;
			commandMintedGeneration.set(command, generation);
			const credential: CommandCredential = { value: result, generation };
			if ((commandInvalidationEpoch.get(command) ?? 0) === epoch) {
				commandFailureRetryAt.delete(command);
				commandResultCache.set(command, credential);
			}
			return credential;
		})
		.catch(error => {
			const code =
				typeof (error as NodeJS.ErrnoException | null)?.code === "string"
					? (error as NodeJS.ErrnoException).code
					: "unknown";
			logger.warn("config: !command value resolution failed", { code });
			if ((commandInvalidationEpoch.get(command) ?? 0) === epoch) {
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
	if (isCommandConfigValue(valueConfig)) return (await executeCommand(valueConfig))?.value;
	const envValue = $envExact(valueConfig);
	return envValue || valueConfig;
}

/**
 * {@link resolveConfigValue}, plus the generation of the credential slot that
 * produced a `!command` value.
 *
 * The auth cascade resolves a provider's configured key through this, so the
 * generation travels with the bearer a request sends — including to a worker,
 * whose credential its owner mints — and a 401 can name the generation it was
 * refused rather than bytes two mints may share.
 */
export async function resolveConfigCredential(
	valueConfig: string,
): Promise<{ value: string; generation?: number } | string | undefined> {
	if (!isCommandConfigValue(valueConfig)) return await resolveConfigValue(valueConfig);
	const credential = await executeCommand(valueConfig);
	return credential && { value: credential.value, generation: credential.generation };
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
	const configs: Record<string, string> = {};
	for (const source of active) {
		Object.assign(configs, typeof source === "function" ? headerConfigs.get(source) : source);
	}
	if (options?.authHeader && options.apiKeyConfig) configs.Authorization = options.apiKeyConfig;
	const resolver: ConfigHeaderResolver = async signal => {
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
	headerConfigs.set(resolver, configs);
	return resolver;
}

/** Clear all command state, generation counters included. Exported for focused resolver tests. */
export function clearConfigValueCache(): void {
	invalidateAllCommandConfigs();
	commandInFlight.clear();
	commandInvalidationEpoch.clear();
	commandMintedGeneration.clear();
	commandRefusedGeneration.clear();
}
