import { OAUTH_REFRESH_SKEW_MS } from "@oh-my-pi/pi-ai/auth/refresh";
import { CredentialSourceError } from "@oh-my-pi/pi-ai/error";
import { executeShell } from "@oh-my-pi/pi-natives";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import {
	$envExact,
	directoryIsEnterable,
	getProjectDir,
	isRecord,
	logger,
	ptree,
	untilAborted,
} from "@oh-my-pi/pi-utils";
import { effectsSettings } from "./registry";

const COMMAND_FAILURE_RETRY_MS = 30_000;
/**
 * Shortest time one successful run is reused before its command may run again. Without it a
 * command printing a JWT already inside the refresh skew would run once per request.
 */
const COMMAND_MIN_REUSE_MS = 30_000;
/** Reuse of a value with no discoverable expiry, in ms (`providers.commandRefreshSeconds`); 0 = until invalidated. */
let commandRefreshMs = 0;
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
/**
 * One successful run of a `!command` value: what it printed, when, and when that
 * output stops being valid.
 */
interface CommandResult {
	value: string;
	/** `Date.now()` when the run finished. */
	mintedAt: number;
	/** The `exp` claim of a JWT value, in ms. Such a value is never served at or after it. */
	expiresAt: number | undefined;
	/**
	 * The same deadline read on `performance.now()`, which no clock change moves. A
	 * value is served only while BOTH deadlines are ahead, so a wall clock that is
	 * set backwards cannot extend a credential past the lifetime it was minted with.
	 */
	monoExpiresAt: number | undefined;
}

/**
 * Fresh stdout, served without re-running the command until the run is due
 * again (see {@link refreshAt}) or the value is invalidated.
 */
const commandResultCache = new Map<string, CommandResult>();
/**
 * The last stdout each command produced. When a re-run fails, resolution keeps
 * serving it and retries the command in the background, until the value expires
 * or a 401 rejects it.
 */
const commandLastGood = new Map<string, CommandResult>();
const commandFailureRetryAt = new Map<string, number>();
/**
 * Why each command's latest run produced no value, kept until a run succeeds or
 * the value is invalidated. A credential that resolves to nothing is reported
 * with it, instead of as a provider's 401 or a bare "No API key".
 */
const commandLastFailure = new Map<string, CommandFailureRecord>();
const commandInFlight = new Map<string, Promise<CommandRunOutcome>>();
const commandGeneration = new Map<string, number>();

/**
 * Why cached command values are dropped. `rejected`: a 401 proved the value
 * stale, so a command's last good value goes too. `refresh`: a re-mint was asked
 * for (`omp models refresh`, F5, a forced credential renewal that is not a 401);
 * a failing re-run still serves the last good value.
 */
export type ConfigValueInvalidation = "rejected" | "refresh";

type CommandFailure = {
	ok: false;
	reason: "timeout" | "killed" | "exit" | "empty" | "spawn" | "cwd-unavailable" | "expired";
	exitCode?: number | null;
	code?: string;
};

type CommandOutcome = { ok: true; value: string } | CommandFailure;

/** A failed run, with the time limit it ran under, for the message. */
type CommandFailureRecord = { outcome: CommandFailure; timeoutMs: number };

/**
 * What resolving a command value produced: its stdout, or nothing together with
 * the run that explains it. The reason travels with the resolution rather than
 * being looked up afterwards, so a concurrent invalidation cannot erase it
 * between a caller finding no value and reporting why.
 */
type CommandResolution = { value: string } | { value: undefined; failure?: CommandFailureRecord };

/**
 * What one finished run produced: a result with its deadlines, or nothing with the
 * reason. A result travels whole so the waiter re-checks the deadline itself; the
 * run's own check was made at a moment that has already passed.
 */
type CommandRunOutcome = { result: CommandResult } | { result: undefined; failure: CommandFailureRecord };

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
		// Any finite `exp` is an expiry, including `0` and a negative one. Reading only
		// a positive `exp` classified those as a value with NO discoverable expiry, so
		// an already-dead token was served and then kept under the default reuse.
		return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
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

/**
 * A result's value while it may be sent: a JWT never at or after its `exp`, on the
 * wall clock and on the monotonic clock alike. A value with no discoverable expiry
 * is always servable; only invalidation or the configured reuse retires it.
 */
function servable(result: CommandResult | undefined, now: number): string | undefined {
	if (result === undefined) return undefined;
	if (result.expiresAt === undefined) return result.value;
	const monoExpiresAt = result.monoExpiresAt ?? Number.POSITIVE_INFINITY;
	return now < result.expiresAt && performance.now() < monoExpiresAt ? result.value : undefined;
}

/** One successful run's stdout with both deadlines fixed at the moment it was minted. */
function commandResult(value: string): CommandResult {
	const mintedAt = Date.now();
	const expiresAt = jwtExpiresAt(value);
	return {
		value,
		mintedAt,
		expiresAt,
		monoExpiresAt: expiresAt === undefined ? undefined : performance.now() + (expiresAt - mintedAt),
	};
}

/**
 * Drop every held copy of a command's value that is past its expiry. Once a result
 * has been observed expired it is gone, so a wall clock that is later set back
 * before that expiry finds nothing left to revive.
 */
function discardExpired(command: string, now: number): void {
	const cached = commandResultCache.get(command);
	if (cached !== undefined && servable(cached, now) === undefined) commandResultCache.delete(command);
	const lastGood = commandLastGood.get(command);
	if (lastGood !== undefined && servable(lastGood, now) === undefined) commandLastGood.delete(command);
}

/**
 * Identify command-backed values when collecting credentials that must be
 * invalidated together. The predicate names the `!` form rather than `string`,
 * so a caller's other branch still holds the config text it was given instead of
 * being narrowed to nothing.
 */
export function isCommandConfigValue(valueConfig: string | undefined): valueConfig is `!${string}` {
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
	commandLastFailure.delete(command);
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
	commandLastFailure.clear();
	commandInFlight.clear();
	if (reason === "rejected") commandLastGood.clear();
}

/**
 * Note a run that produced no usable value, so the next resolution can say why
 * instead of reporting a missing key, and hold the retry off for the backoff.
 */
function recordCommandFailure(
	command: string,
	outcome: CommandFailure,
	timeoutMs: number,
	current: boolean,
): CommandRunOutcome {
	const failure: CommandFailureRecord = { outcome, timeoutMs };
	if (current) {
		commandFailureRetryAt.set(command, Date.now() + COMMAND_FAILURE_RETRY_MS);
		commandLastFailure.set(command, failure);
	}
	return { result: undefined, failure };
}

function errnoCode(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === "string" ? code : "unknown";
}

async function resolveCommandResolution(
	valueConfig: string,
	commandTimeout: CommandTimeoutSource | undefined,
): Promise<CommandResolution> {
	const command = commandKey(valueConfig);
	const now = Date.now();
	// Observing a value at or past its expiry retires it here: a clock set backwards
	// afterwards must not find it again.
	discardExpired(command, now);
	const cached = commandResultCache.get(command);
	// A successful run serves until its command is due again: a JWT one refresh skew
	// before its `exp`, any other value after `providers.commandRefreshSeconds`. Past
	// that the command runs again, so a time-limited token is replaced before a
	// provider rejects it rather than after.
	if (cached !== undefined && now < refreshAt(cached)) {
		const fresh = servable(cached, now);
		if (fresh !== undefined) return { value: fresh };
	}
	const lastGood = servable(commandLastGood.get(command), now);
	const retryAt = commandFailureRetryAt.get(command);
	if (retryAt !== undefined && now < retryAt) {
		// Inside the backoff window no run happens, so the recorded failure is this
		// resolution's reason. It is read with no await in between, so nothing can clear
		// it between deciding there is no value and saying why.
		if (lastGood !== undefined) return { value: lastGood };
		return { value: undefined, failure: commandLastFailure.get(command) };
	}
	const generation = commandGeneration.get(command) ?? 0;
	const run = commandInFlight.get(command) ?? startCommandRun(command, commandTimeoutMsFor(commandTimeout));
	// After a failed run, the retry runs in the background while the last good value serves.
	if (retryAt !== undefined && lastGood !== undefined) return { value: lastGood };
	const settled = await run;
	// An invalidation while the run was in flight (a 401, an explicit refresh) made its
	// output stale: resolve again instead of handing the old value to this waiter.
	if ((commandGeneration.get(command) ?? 0) !== generation) {
		return resolveCommandResolution(valueConfig, commandTimeout);
	}
	if (settled.result !== undefined) {
		// Awaiting is not instant, and this waiter may have queued behind others: a
		// value servable when the run finished can be past its `exp` by the time the
		// waiter resumes, so the deadline is checked again here rather than trusted.
		const after = Date.now();
		discardExpired(command, after);
		const fresh = servable(settled.result, after);
		if (fresh !== undefined) return { value: fresh };
		return {
			value: undefined,
			failure: { outcome: { ok: false, reason: "expired" }, timeoutMs: commandTimeoutMsFor(commandTimeout) },
		};
	}
	// A 401 during the run drops the last good value, so read it after the run.
	const served = servable(commandLastGood.get(command), Date.now());
	return served !== undefined ? { value: served } : { value: undefined, failure: settled.failure };
}

async function resolveCommandValue(
	valueConfig: string,
	commandTimeout: CommandTimeoutSource | undefined,
): Promise<string | undefined> {
	return (await resolveCommandResolution(valueConfig, commandTimeout)).value;
}

function startCommandRun(command: string, timeoutMs: number): Promise<CommandRunOutcome> {
	const generation = commandGeneration.get(command) ?? 0;
	const startedAt = performance.now();
	const promise: Promise<CommandRunOutcome> = runConfigCommand(command, timeoutMs)
		.then(outcome => {
			const current = (commandGeneration.get(command) ?? 0) === generation;
			if (outcome.ok) {
				const result = commandResult(outcome.value);
				// A command can print a credential already past its `exp`: a stale cache
				// inside the minting tool, a clock apart from the issuer's. That is a
				// failed mint, not a value. Caching or returning it would send a
				// credential the provider has already stopped accepting — the 401 this
				// whole lifetime exists to prevent — under the one path, a fresh run,
				// that never passed the expiry check.
				if (servable(result, result.mintedAt) !== undefined) {
					if (current) {
						commandFailureRetryAt.delete(command);
						commandLastFailure.delete(command);
						commandResultCache.set(command, result);
						commandLastGood.set(command, result);
					}
					return { result };
				}
				// Never log the value, and never the command: both carry the secret.
				logger.warn("config: !command value resolution produced an expired credential", {
					expiredForMs: result.mintedAt - (result.expiresAt ?? result.mintedAt),
					elapsedMs: Math.round(performance.now() - startedAt),
					servingLastGoodValue: current && commandLastGood.has(command),
				});
				return recordCommandFailure(command, { ok: false, reason: "expired" }, timeoutMs, current);
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
			return recordCommandFailure(command, outcome, timeoutMs, current);
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
 * successful stdout is reused — a JWT until the OAuth refresh skew before its
 * `exp`, any other value for `providers.commandRefreshSeconds` (by default until
 * invalidated) — and a failed re-run serves the last good stdout until it expires
 * or a 401 rejects it. Environment-backed and literal values stay live.
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

/**
 * Resolve a configured credential. Same as {@link resolveConfigValue}, but a
 * source that produced nothing rejects with {@link CredentialSourceError}
 * naming the source and what it returned, so the failure is never sent on as a
 * missing or rejected key.
 *
 * Only credentials are read this way. Every other config value — a header, an
 * MCP value, the auth broker's URL — keeps {@link resolveConfigValue}'s
 * literal fallback, so this change cannot alter what they resolve to.
 */
export async function resolveCredentialConfigValue(
	valueConfig: string,
	commandTimeout?: CommandTimeoutSource,
): Promise<string | undefined> {
	if (isCommandConfigValue(valueConfig)) {
		const resolution = await resolveCommandResolution(valueConfig, commandTimeout);
		if (resolution.value !== undefined) return resolution.value;
		const failure = resolution.failure;
		if (failure === undefined) return undefined;
		const what = describeCommandFailure(failure.outcome, failure.timeoutMs);
		throw new CredentialSourceError(undefined, `the command \`${commandLabel(commandKey(valueConfig))}\` ${what}`);
	}
	// A variable that exists was meant to hold the credential, so a value that is
	// empty or only whitespace is a configuration failure rather than a literal key
	// worth sending as a bearer. A whitespace-only value reached the wire as a bare
	// `Bearer`, which a provider answers with the same 401 as a wrong key.
	const envValue = $envExact(valueConfig);
	if (envValue !== undefined && BLANK_VALUE.test(envValue)) {
		throw new CredentialSourceError(
			undefined,
			`environment variable ${valueConfig} is set but ${envValue.length === 0 ? "empty" : "only whitespace"}`,
		);
	}
	// With no such variable the config text is the credential itself, and blank text
	// is no more a credential there than it is in a variable.
	if (envValue === undefined && BLANK_VALUE.test(valueConfig)) {
		throw new CredentialSourceError(
			undefined,
			`the configured value is ${valueConfig.length === 0 ? "empty" : "only whitespace"}`,
		);
	}
	return await resolveConfigValue(valueConfig, commandTimeout);
}

/** A leading `NAME=value` environment assignment of a simple command. */
const COMMAND_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * What `/bin/sh` treats as a word separator, and nothing else. JavaScript's
 * `\s` and `String.trim` also match a nonbreaking space, an em space and a
 * carriage return, which the shell treats as ordinary characters: splitting a
 * word there desynchronised the scan and printed an assignment's value as the
 * program name, into the message and into `~/.omp/logs`.
 */
const SHELL_BLANK = /[ \t\n]/;

/**
 * A value that holds no non-whitespace character: never a credential. Every kind
 * of whitespace counts, unlike {@link SHELL_BLANK}, because none of them is a
 * credential byte. It only tests — a credential that does hold something keeps
 * every byte it was given, leading and trailing blanks included.
 */
const BLANK_VALUE = /^\s*$/;

/** Unquoted shell syntax we do not parse, and will not print past. */
const SHELL_METACHARACTER = /[$`|&;<>(){}*?!~#\n]/;

/**
 * Split off the first shell word of `command`, honoring quotes and backslash
 * escapes, so a program path containing spaces stays one word.
 *
 * `safe` is false when the word contains unquoted shell syntax this does not
 * understand — a substitution, a pipeline, a glob — and when the word ends
 * while a quote is still open. The scan desynchronises from the real shell in
 * both cases, and the text after it is as likely to be a secret as a program
 * name, so callers must print `…` rather than the word.
 */
function firstShellWord(command: string): { word: string; rest: string; safe: boolean } {
	let word = "";
	let quote: '"' | "'" | undefined;
	let safe = true;
	let index = 0;
	for (; index < command.length; index++) {
		const char = command[index];
		if (quote !== undefined) {
			// Inside single quotes nothing is special, not even a backslash. Inside
			// double quotes a backslash escapes only these four, and `\"` must NOT be
			// read as the closing quote: treating it as one desynchronises the scan
			// and prints the rest of the assignment's value as the program name.
			if (quote === '"' && char === "\\" && index + 1 < command.length) {
				const next = command[index + 1];
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					word += next;
					index++;
					continue;
				}
			}
			// A substitution inside double quotes still runs.
			if (quote === '"' && (char === "$" || char === "`")) safe = false;
			if (char === quote) quote = undefined;
			else word += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === "\\" && index + 1 < command.length) {
			// A backslash before a newline is a line continuation: the shell removes both
			// and the word continues, so `fal\<newline>se` is the program `false`.
			if (command[index + 1] === "\n") {
				index++;
				continue;
			}
			word += command[++index];
			continue;
		}
		if (char === undefined || SHELL_BLANK.test(char)) break;
		if (SHELL_METACHARACTER.test(char)) safe = false;
		word += char;
	}
	// The command ran out inside a quote: the real shell would not have ended the
	// word here, so nothing we collected is reliably the program. Fail closed.
	if (quote !== undefined) safe = false;
	return { word, rest: trimShellBlanks(command.slice(index)), safe };
}

function trimShellBlanks(text: string): string {
	let start = 0;
	let end = text.length;
	while (start < end && SHELL_BLANK.test(text[start] as string)) start++;
	while (end > start && SHELL_BLANK.test(text[end - 1] as string)) end--;
	return text.slice(start, end);
}

/**
 * Remove shell line continuations and nothing else. A backslash before a newline
 * is line joining: the shell deletes both before it tokenizes anything, so
 * `LA\<newline>BEL=secret` is the assignment `LABEL=secret`. Inside single quotes
 * the pair is two ordinary characters and stays, and every other backslash keeps
 * the character it escapes, so a quoted or escaped `=` still does not read as
 * assignment syntax.
 */
function joinShellLines(text: string): string {
	if (!text.includes("\\\n")) return text;
	let joined = "";
	let quote: '"' | "'" | undefined;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (quote === "'") {
			if (char === "'") quote = undefined;
			joined += char;
			continue;
		}
		if (char === "\\" && index + 1 < text.length) {
			if (text[index + 1] === "\n") {
				index++;
				continue;
			}
			joined += char + text[index + 1];
			index++;
			continue;
		}
		if (quote === undefined && (char === "'" || char === '"')) quote = char;
		else if (char === quote) quote = undefined;
		joined += char;
	}
	return joined;
}

/**
 * The program a command runs, for messages. Only the program is shown, never an
 * argument: a credential command's arguments carry secrets. The same is true of
 * a leading `NAME=value` assignment, so those are reported by name with the
 * value dropped, and the home directory is shortened out of the program path.
 */
function commandLabel(command: string): string {
	let rest = trimShellBlanks(command);
	const parts: string[] = [];
	let elided = false;
	while (rest.length > 0) {
		// Whether this word is a shell assignment is decided on the raw text with only
		// line continuations joined, before any quote or escape removal. Deciding it on
		// the decoded word classified `'LABEL=x'`, `LABEL\=x` and `LA'BEL'=x` — every
		// one an executable word — as assignments, and then printed their first
		// ARGUMENT as the program name. Deciding it on the raw text alone missed
		// `LA\<newline>BEL=secret`, which IS an assignment, and printed the whole
		// `LABEL=secret` word as the program name instead.
		const name = COMMAND_ASSIGNMENT.exec(joinShellLines(rest))?.[0];
		if (name === undefined) break;
		const next = firstShellWord(rest);
		if (next.word.length === 0) break;
		parts.push(`${name.slice(0, -1)}=…`);
		// The name is safe, the value was not parsed: stop before printing anything
		// after a substitution we do not understand. `SECRET=$(mint) prog` reads as
		// `SECRET=… …`, never as the substitution's text.
		if (!next.safe) {
			elided = true;
			break;
		}
		rest = next.rest;
	}
	if (!elided) {
		const program = firstShellWord(rest);
		if (program.word.length > 0 && program.safe) parts.push(shortenPath(program.word));
		else elided = true;
		if (program.rest.length > 0) elided = true;
	}
	if (elided || parts.length === 0) parts.push("…");
	return parts.join(" ");
}

function formatSeconds(ms: number): string {
	const seconds = ms / 1000;
	return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
}

function describeCommandFailure(failure: CommandFailure, timeoutMs: number): string {
	switch (failure.reason) {
		case "timeout":
			return `timed out after ${formatSeconds(timeoutMs)}, the providers.commandTimeoutSeconds limit`;
		case "killed":
			return "was killed before it finished";
		case "exit":
			return `exited with status ${failure.exitCode ?? "unknown"}`;
		case "empty":
			return "exited 0 but printed nothing";
		case "spawn":
			return `could not be started (${failure.code ?? "unknown error"})`;
		case "cwd-unavailable":
			return "was not run: the project directory is not accessible";
		case "expired":
			return "printed a credential that had already expired";
	}
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
			// The derived bearer is a credential, so it follows the credential rule: a
			// source that produced nothing adds no header, instead of sending the
			// variable's own name over a valid runtime key. Headers never throw.
			const apiKey = await untilAborted(signal, () =>
				resolveCredentialConfigValue(keyConfig).catch(error => {
					if (error instanceof CredentialSourceError) return undefined;
					throw error;
				}),
			);
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
	commandRefreshMs = 0;
}
