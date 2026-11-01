import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isatty } from "node:tty";
import { parseEnv } from "node:util";
import { getAgentDir, getConfigRootDir, getProjectDir, refreshDirsFromEnv } from "./dirs";
import {
	NotARegularFile,
	PipeNotAnswered,
	readRegularFileOrPipeTextSync,
	readRegularFileTextSync,
	reportFileWait,
	reportSkippedFile,
} from "./regular-file";
import { isBunTestRuntime } from "./test-runtime";

export * from "./test-runtime";
export * from "./worker-host";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Strict shell-identifier shape. Used for dotenv keys we accept into
 * `Bun.env` — those should be referenceable as `$NAME` from POSIX shells,
 * so we reject anything outside `[A-Za-z_][A-Za-z0-9_]*`.
 */
export function isValidEnvName(name: string): boolean {
	return ENV_NAME_RE.test(name);
}

/**
 * The only names that are genuinely unsafe to forward to a native `execve`
 * spawn: empty, containing `=` (would corrupt the `KEY=VALUE` framing) or
 * NUL (terminates the C string mid-entry). Windows ships standard variables
 * whose names contain parentheses (e.g. `ProgramFiles(x86)`, `CommonProgramFiles(x86)`)
 * — those MUST survive the scrub so downstream resolvers (Git Bash discovery
 * in `procmgr.ts`, etc.) can still read them.
 */
export function isSafeEnvName(name: string): boolean {
	return name.length > 0 && !name.includes("=") && !name.includes("\0");
}

export function isSafeEnvValue(value: string): boolean {
	return !value.includes("\0");
}

export function isMacosMallocStackLoggingEnvName(name: string): boolean {
	return name === "MallocStackLogging" || name === "MallocStackLoggingNoCompact";
}

/**
 * True when running inside a WSL (Windows Subsystem for Linux) distribution.
 *
 * WSL reports `linux` for `process.platform`, so the only reliable signal is
 * the `WSL_DISTRO_NAME`/`WSL_INTEROP` variables the interop layer injects.
 * Callers use this to translate Windows drive paths to their `/mnt/<drive>`
 * mounts and to route clipboard access through `powershell.exe`.
 */
export function isWsl(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
	return platform === "linux" && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
}

export function filterProcessEnv(env: Record<string, string | undefined>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const key in env) {
		const value = env[key];
		if (
			!isSafeEnvName(key) ||
			isMacosMallocStackLoggingEnvName(key) ||
			value === undefined ||
			!isSafeEnvValue(value)
		) {
			continue;
		}
		result[key] = value;
	}
	return result;
}
/**
 * Git variables that pin a repository location. They describe the checkout the
 * agent process itself was launched from (git hooks, `git --git-dir` wrappers),
 * so forwarding them to a child shell makes `git` ignore the command's `cwd`
 * and mutate the wrong worktree or index. Stripped from child shell envs so git
 * rediscovers the repository from the working directory. Mirrors the
 * `env_remove` list in `crates/pi-vcs/src/git/cli.rs`.
 */
const GIT_REPO_LOCATION_ENV_NAMES = [
	"GIT_DIR",
	"GIT_COMMON_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
] as const;

/**
 * Removes {@link GIT_REPO_LOCATION_ENV_NAMES} from a copied child env in place.
 *
 * Windows environment lookups are case-insensitive, so a block that spells a
 * variable `git_dir` is just as binding there; match case-insensitively on
 * win32 and exactly elsewhere (POSIX env names are case-sensitive).
 */
export function stripGitRepoLocationEnv(
	env: Record<string, string>,
	platform: NodeJS.Platform = process.platform,
): void {
	if (platform !== "win32") {
		for (const name of GIT_REPO_LOCATION_ENV_NAMES) {
			delete env[name];
		}
		return;
	}
	const folded = new Set<string>(GIT_REPO_LOCATION_ENV_NAMES.map(name => name.toLowerCase()));
	for (const key of Object.keys(env)) {
		if (folded.has(key.toLowerCase())) {
			delete env[key];
		}
	}
}

// Bun autoloads the project's dotenv files into `process.env` before user code
// runs — including inside `bun build --compile` binaries — so a snapshot of
// `Bun.env` is only pre-dotenv when autoloading was explicitly disabled. Linux
// keeps the original exec environment in procfs, which is authoritative.
function readLaunchEnv(): ReadonlyMap<string, string> | undefined {
	if (process.platform === "linux") {
		try {
			const values = new Map<string, string>();
			for (const entry of fs.readFileSync("/proc/self/environ", "utf8").split("\0")) {
				const separator = entry.indexOf("=");
				if (separator > 0) values.set(entry.slice(0, separator), entry.slice(separator + 1));
			}
			return values;
		} catch {}
	}
	if (!process.execArgv.includes("--no-env-file")) return undefined;
	const values = new Map<string, string>();
	for (const key in Bun.env) {
		const value = Bun.env[key];
		if (value !== undefined) values.set(key, value);
	}
	return values;
}

const launchEnvValues = readLaunchEnv();
const projectEnvNamesLoadedByOmp = new Set<string>();

function expandDotenvValues(values: Record<string, string>, env: Record<string, string>): Record<string, string> {
	const expanded: Record<string, string> = {};
	for (const key in values) {
		expanded[key] = values[key].replace(
			/(\\)?\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
			(match, escaped: string | undefined, braced: string | undefined, bare: string | undefined) => {
				if (escaped) return match.slice(1);
				const name = braced ?? bare;
				if (!name) return match;
				return env[name] ?? expanded[name] ?? "";
			},
		);
	}
	return expanded;
}

function filterChildShellEnvInternal(
	env: Record<string, string | undefined>,
	cwd: string,
	onDotenvValue?: (value: string) => void,
): Record<string, string> {
	const runtimeLaunchEnvValues = env === Bun.env || env === process.env ? launchEnvValues : undefined;
	const result = filterProcessEnv(env);
	const projectEnv = parseEnvFile(path.join(cwd, ".env"));
	const launchNodeEnv = runtimeLaunchEnvValues ? runtimeLaunchEnvValues.get("NODE_ENV") : env.NODE_ENV;
	const nodeEnvName = `.env.${launchNodeEnv || "development"}`;
	const modeEnv = parseEnvFile(path.join(cwd, nodeEnvName));
	const localEnv = parseEnvFile(path.join(cwd, ".env.local"));
	const modeLocalEnv = parseEnvFile(path.join(cwd, `${nodeEnvName}.local`));
	const launchEnv = { ...projectEnv, ...modeEnv, ...localEnv, ...modeLocalEnv };
	const expandedLaunchEnv = {
		...expandDotenvValues(projectEnv, result),
		...expandDotenvValues(modeEnv, result),
		...expandDotenvValues(localEnv, result),
		...expandDotenvValues(modeLocalEnv, result),
	};
	let fallbackLaunchEnv: Record<string, string> | undefined;
	let expandedFallbackLaunchEnv: Record<string, string> | undefined;
	if (!runtimeLaunchEnvValues && nodeEnvName !== ".env.development") {
		const fallbackModeEnv = parseEnvFile(path.join(cwd, ".env.development"));
		const fallbackModeLocalEnv = parseEnvFile(path.join(cwd, ".env.development.local"));
		const candidate = { ...projectEnv, ...fallbackModeEnv, ...localEnv, ...fallbackModeLocalEnv };
		const expandedCandidate = {
			...expandDotenvValues(projectEnv, result),
			...expandDotenvValues(fallbackModeEnv, result),
			...expandDotenvValues(localEnv, result),
			...expandDotenvValues(fallbackModeLocalEnv, result),
		};
		if (candidate.NODE_ENV === env.NODE_ENV || expandedCandidate.NODE_ENV === env.NODE_ENV) {
			// Without a launch snapshot, NODE_ENV may itself have come from dotenv.
			// Bun chose the default mode before loading it, so retain both candidates.
			fallbackLaunchEnv = candidate;
			expandedFallbackLaunchEnv = expandedCandidate;
		}
	}
	const allLaunchEnv = fallbackLaunchEnv ? { ...launchEnv, ...fallbackLaunchEnv } : launchEnv;
	if (onDotenvValue) {
		// Every value the project's dotenv files define is dotenv-sourced, whether
		// or not this process loaded it (a `--cwd` launch never did).
		for (const key in allLaunchEnv) onDotenvValue(allLaunchEnv[key]!);
		for (const key in expandedLaunchEnv) onDotenvValue(expandedLaunchEnv[key]!);
	}
	for (const key in allLaunchEnv) {
		const launchValue = runtimeLaunchEnvValues?.get(key);
		if (launchValue !== undefined) {
			// Launcher-owned name: it keeps the launcher's own value. Bun overwrites
			// an empty launcher value with the dotenv one, so restore the launcher
			// value whenever what survived is exactly what the dotenv file defines.
			if (
				result[key] !== launchValue &&
				(result[key] === launchEnv[key] ||
					result[key] === expandedLaunchEnv[key] ||
					result[key] === fallbackLaunchEnv?.[key] ||
					result[key] === expandedFallbackLaunchEnv?.[key])
			) {
				result[key] = launchValue;
			}
			continue;
		}
		if (runtimeLaunchEnvValues || projectEnvNamesLoadedByOmp.has(key)) {
			// Strong provenance: the launch environment is known and this name is
			// absent from it, or OMP itself injected the value — either way it came
			// from a project dotenv file, not the parent shell.
			const value = result[key];
			if (value !== undefined) onDotenvValue?.(value);
			delete result[key];
		} else if (
			result[key] === launchEnv[key] ||
			result[key] === expandedLaunchEnv[key] ||
			result[key] === fallbackLaunchEnv?.[key] ||
			result[key] === expandedFallbackLaunchEnv?.[key]
		) {
			// No launch-env snapshot (dotenv autoloaded without procfs): best-effort
			// value match against the Bun-parsed dotenv.
			const value = result[key];
			if (value !== undefined) onDotenvValue?.(value);
			delete result[key];
		}
	}
	// Last, after dotenv merging: no source (inherited, launcher, or dotenv) may
	// pin the child shell to the agent's own repository.
	stripGitRepoLocationEnv(result);
	return result;
}

/** Filters process env for child shells without launch-cwd dotenv values. */
export function filterChildShellEnv(
	env: Record<string, string | undefined>,
	cwd: string = getProjectDir(),
): Record<string, string> {
	return filterChildShellEnvInternal(env, cwd);
}

/** Return every value defined by `cwd`'s dotenv files, plus environment values that came from them. */
export function getDotenvEnvValues(
	cwd: string = getProjectDir(),
	env: Record<string, string | undefined> = process.env,
): string[] {
	const values = new Set<string>();
	filterChildShellEnvInternal(env, cwd, value => values.add(value));
	return [...values];
}

/**
 * How long a `.env` that is a named pipe gets at startup, from the open, for
 * its writer to close it, when no one is at a terminal. 1Password mounts `.env`
 * files as named pipes on purpose and writes the file when a reader opens it.
 * An unlocked 1Password needs no person to answer; a locked one shows an
 * authorization prompt, and with no terminal there is usually no one to approve
 * it, so a long wait only delays the command. Not measured against a real
 * 1Password mount: a judgement. A slower answer leaves that file's variables
 * unset, and the note says so.
 */
export const ENV_PIPE_DEADLINE_MS = 10_000;

/**
 * {@link ENV_PIPE_DEADLINE_MS} when standard input and standard error are both
 * a terminal: a person is there to find and approve 1Password's authorization
 * prompt, sees the note that omp is waiting, and can press Ctrl-C. Also a
 * judgement, not a measurement.
 */
export const ENV_PIPE_TERMINAL_DEADLINE_MS = 60_000;

/** The most a `.env` pipe may send: far more than any `.env` holds, and a bound on what a writer that never stops can make omp hold. */
const ENV_PIPE_MAX_BYTES = 1024 * 1024;

/** How long a `.env` pipe may stay silent before omp says it is waiting: a mount that answers at once needs no note. */
const ENV_PIPE_NOTICE_AFTER_MS = 500;

/**
 * The text each `.env` read at startup held, by path. A child shell's
 * environment and the stream redactor read the project's `.env` files again;
 * when one is a named pipe, they take what startup read from it instead of
 * waiting on it again. 1Password's mounts are not built for repeated or
 * concurrent reads, and the values startup loaded are the ones those readers
 * need.
 */
const startupEnvText = new Map<string, string>();

/** `.env` pipes that did not answer at startup: this process does not wait on them again. */
const unansweredEnvPipes = new Set<string>();

/**
 * A `.env` read before any command runs: a named pipe is read until its writer
 * closes it, within a bound. A writer that dies part way through the file also
 * closes it, and what it wrote by then is parsed as the whole file: no bound or
 * check here can tell the two apart.
 */
function startupEnvFileText(filePath: string): string | undefined {
	const key = path.resolve(filePath);
	if (unansweredEnvPipes.has(key)) return undefined;
	const deadlineMs = isatty(0) && isatty(2) ? ENV_PIPE_TERMINAL_DEADLINE_MS : ENV_PIPE_DEADLINE_MS;
	const bound = `${deadlineMs / 1000} s`;
	try {
		const text = readRegularFileOrPipeTextSync(filePath, {
			deadlineMs,
			maxBytes: ENV_PIPE_MAX_BYTES,
			noticeAfterMs: ENV_PIPE_NOTICE_AFTER_MS,
			onWait: (started, stoppable) =>
				reportFileWait(
					`omp is waiting up to ${bound} for ${filePath}: it is a named pipe, and ` +
						`${started ? "what is writing it has not finished" : "nothing has written it yet"}. ` +
						`If 1Password serves it, approve its authorization prompt. ` +
						(stoppable ? "Ctrl-C stops omp." : "Ctrl-C takes effect when the wait ends."),
				),
		});
		if (text !== undefined) startupEnvText.set(key, text);
		return text;
	} catch (error) {
		if (error instanceof NotARegularFile) {
			reportSkippedFile(error);
			return undefined;
		}
		if (!(error instanceof PipeNotAnswered)) throw error;
		unansweredEnvPipes.add(key);
		const cause =
			error.reason === "silent"
				? `nothing wrote to it within ${bound}`
				: error.reason === "unfinished"
					? `what was writing it did not finish within ${bound}`
					: `what was writing it sent more than ${ENV_PIPE_MAX_BYTES / 1024} KiB, more than a .env file holds`;
		reportSkippedFile({
			file: filePath,
			message:
				`omp did not load ${filePath}: it is a named pipe, and ${cause}, so every variable it sets is unset ` +
				`for this command. If 1Password serves it, unlock 1Password and approve its prompt; otherwise put a ` +
				`regular file there.`,
		});
		return undefined;
	}
}

/**
 * A `.env` read again while omp runs, to build a child shell's environment or
 * the redactor's list: never waited on. A named pipe gives what startup read
 * from it, or is refused like any other file that is not a regular file.
 */
function runtimeEnvFileText(filePath: string): string | undefined {
	try {
		return readRegularFileTextSync(filePath);
	} catch (error) {
		if (!(error instanceof NotARegularFile)) throw error;
		const loaded = error.kind === "a FIFO" ? startupEnvText.get(path.resolve(filePath)) : undefined;
		if (loaded !== undefined) return loaded;
		reportSkippedFile(error);
		return undefined;
	}
}

/**
 * Parses .env text with the runtime's dotenv grammar, then retains
 * only shell-identifier names and spawn-safe values before mirroring valid
 * `OMP_` variables to their `PI_` aliases.
 */
function parseEnvText(read: () => string | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	try {
		const text = read();
		if (text !== undefined) {
			const parsed = parseEnv(text);
			for (const key in parsed) {
				const value = parsed[key];
				if (value !== undefined && isValidEnvName(key) && isSafeEnvValue(value)) result[key] = value;
			}
		}
	} catch {
		// The file can't be read or parsed - return empty result
	}

	// OMP_ overrides PI_
	for (const k in result) {
		if (k.startsWith("OMP_")) {
			result[`PI_${k.slice(4)}`] = result[k];
		}
	}

	return result;
}

/**
 * Parses a .env file (see {@link parseEnvText}) without ever waiting on it: a
 * regular file is read; a named pipe gives what startup read from it, or is
 * refused; a socket, device or directory is refused. A refusal is reported once
 * and gives no variables.
 */
export function parseEnvFile(filePath: string): Record<string, string> {
	return parseEnvText(() => runtimeEnvFileText(filePath));
}

// Eagerly parse the user's $HOME/.env and the current project's .env (from cwd).
// Only these reads, before any command runs, wait on a named pipe.
const homeEnv = parseEnvText(() => startupEnvFileText(path.join(os.homedir(), ".env")));
const piEnv = parseEnvText(() => startupEnvFileText(path.join(getConfigRootDir(), ".env")));
const agentEnv = parseEnvText(() => startupEnvFileText(path.join(getAgentDir(), ".env")));
const projectEnv = parseEnvText(() => startupEnvFileText(path.join(getProjectDir(), ".env")));

for (const key of Object.keys(Bun.env)) {
	const value = Bun.env[key];
	if (!isSafeEnvName(key) || isMacosMallocStackLoggingEnvName(key) || value === undefined || !isSafeEnvValue(value)) {
		delete Bun.env[key];
	}
}

for (const file of [projectEnv, agentEnv, piEnv, homeEnv]) {
	for (const key in file) {
		if (!isMacosMallocStackLoggingEnvName(key) && !Bun.env[key]) {
			Bun.env[key] = file[key];
			if (file === projectEnv) projectEnvNamesLoadedByOmp.add(key);
		}
	}
}

// Directory-affecting keys (XDG_*_HOME, and in default mode PI_CODING_AGENT_DIR)
// may have just arrived from the profile/agent `.env` applied above. The dirs
// resolver cached its paths at module load — before this file ran — so rebuild
// it now from the updated env. `getAgentDir()` already located the `.env` from
// the profile name + home, so this re-reads only the directory vars.
refreshDirsFromEnv();

/**
 * Intentional re-export of Bun.env.
 *
 * All users should import this env module (import { $env } from "@oh-my-pi/pi-utils")
 * before using environment variables. This ensures that .env files have been loaded and
 * overrides (project, home) have been applied, so $env always reflects the correct values.
 */
export const $env: Record<string, string> = Bun.env as Record<string, string>;

/**
 * Resolve the first environment variable value from the given keys.
 * @param keys - The keys to resolve.
 * @returns The first environment variable value, or undefined if no value is found.
 */
export function $pickenv(...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = Bun.env[key]?.trim();
		if (value) {
			return value;
		}
	}
	return undefined;
}

/**
 * Read an environment variable by its EXACT, case-sensitive name.
 *
 * `process.env` / `Bun.env` lookups are case-insensitive on Windows (Node backs
 * them with `uv_os_getenv`, Bun with a `CaseInsensitiveASCIIStringArrayHashMap`),
 * so a lowercase literal like `public` silently resolves to a differently-cased
 * system variable — Windows ships `PUBLIC=C:\Users\Public`. Enumerated keys are
 * the only signal that preserves the real casing, so this trusts the lookup only
 * when a key with identical casing is actually present. On POSIX (case-sensitive
 * env) it is equivalent to a direct lookup.
 *
 * Use this instead of `process.env[name] ?? literal` wherever `name` may be a
 * user-supplied literal (e.g. a stored API key) rather than a genuine env-var
 * reference — otherwise the literal gets hijacked by a same-named system var.
 *
 * @param name - Environment variable name to look up.
 * @param env - Environment source; defaults to `process.env`.
 */
export function $envExact(name: string, env: Record<string, string | undefined> = process.env): string | undefined {
	const value = env[name];
	if (value === undefined) return undefined;
	// Enumeration preserves real key casing on Windows, unlike the getter; the
	// value is trusted only when an exact-case entry actually exists.
	for (const key in env) {
		if (key === name) return value;
	}
	return undefined;
}

/**
 * Parses a positive decimal integer from `$env[name]`.
 * Empty, invalid, NaN, zero, or negative values return `defaultValue`.
 */
export function $envpos(name: string, defaultValue: number): number {
	const raw = $env[name];
	if (!raw) return defaultValue;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed) || parsed <= 0) return defaultValue;
	return parsed;
}

let terminalHeadless = isBunTestRuntime();

/**
 * True when real-terminal side effects must be suppressed: stdout escape/frame
 * writes, stdin raw-mode + resume, CSI/OSC capability probes, SIGWINCH, window
 * title changes, and emergency restore. Defaults to {@link isBunTestRuntime} so
 * `bun test` launched inside a real TTY never paints the TUI, leaks probe
 * queries, or hijacks the developer's stdin; production runtimes stay
 * interactive.
 *
 * Terminal-contract tests that must exercise the real I/O path opt out with
 * `setTerminalHeadless(false)` and restore it afterwards.
 */
export function isTerminalHeadless(): boolean {
	return terminalHeadless;
}

/**
 * Override the {@link isTerminalHeadless} default and return the previous value
 * so callers can restore exact prior state (`const prev = setTerminalHeadless(false); … setTerminalHeadless(prev);`).
 */
export function setTerminalHeadless(headless: boolean): boolean {
	const previous = terminalHeadless;
	terminalHeadless = headless;
	return previous;
}

let interactiveHost = false;

/**
 * True when this process runs an interactive coding-agent host — the only
 * context where the operator can browse the Agent Hub and focus a live
 * subagent's session (`SessionFocusController`), so a subagent's session title
 * can become operator-visible. Off by default (print/RPC/ACP/eval/SDK/`bun
 * test` never render a focusable session tree); the interactive entrypoint
 * flips it on with {@link setInteractiveHost}.
 */
export function isInteractiveHost(): boolean {
	return interactiveHost;
}

/**
 * Set the interactive-host flag and return the previous value so callers can
 * restore exact prior state. See {@link isInteractiveHost}.
 */
export function setInteractiveHost(interactive: boolean): boolean {
	const previous = interactiveHost;
	interactiveHost = interactive;
	return previous;
}

/**
 * SQLite `busy_timeout` for the session-critical databases (agent.db,
 * history.db, stats.db).
 *
 * Interactive hosts tolerate a longer synchronous wait on lock contention
 * (SQLITE_BUSY during WAL recovery/checkpoint — see oh-my-pi#2421): the
 * operator sees a brief freeze and the statement eventually completes.
 * Headless hosts (print/RPC/ACP/eval/SDK) run a protocol on the same thread —
 * a multi-second synchronous busy-wait freezes their event loop and stalls
 * every in-flight frame with no liveness signal, so they use a short timeout
 * and rely on the existing asynchronous open/retry paths to recover from
 * contention instead of blocking.
 */
export function getDbBusyTimeoutMs(): number {
	return isInteractiveHost() ? 5000 : 1000;
}

/**
 * True when this code is running inside a `bun build --compile` standalone
 * binary. Detects via the embedded virtual-filesystem path markers
 * (`$bunfs`, `~BUN`, or its URL-encoded form `%7EBUN`) in `import.meta.url`,
 * which Bun rewrites for every module bundled into the executable. The
 * `PI_COMPILED` env var (set by the build script's `--define`) is checked
 * first for cheap fast-path detection.
 */
export function isCompiledBinary(): boolean {
	if (process.env.PI_COMPILED || Bun.env.PI_COMPILED) return true;
	const url = import.meta.url;
	return url.includes("$bunfs") || url.includes("~BUN") || url.includes("%7EBUN");
}

const TRUTHY: Dict<boolean> = {
	"1": true,
	Y: true,
	y: true,
	TRUE: true,
	true: true,
	YES: true,
	yes: true,
	ON: true,
	on: true,
};
/** Parse a boolean-ish env value ("1", "yes", "on", …); `def` when unset/empty. */
export function parseFlag(value: string | undefined, def = false): boolean {
	if (!value) return def;
	return TRUTHY[value] === true;
}

export function $flag(name: string, def: boolean = false): boolean {
	return parseFlag($env[name], def);
}
