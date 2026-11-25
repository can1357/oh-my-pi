import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getConfigRootDir, getProjectDir, refreshDirsFromEnv } from "./dirs";
import {
	filterChildShellEnvInternal,
	isMacosMallocStackLoggingEnvName,
	isSafeEnvName,
	isSafeEnvValue,
	markProjectEnvNameLoadedByOmp,
	OPERATOR_ONLY_ENV_NAMES,
	parseEnvFile,
} from "./dotenv-provenance";
import { isBunTestRuntime } from "./test-runtime";

export {
	filterProcessEnv,
	isMacosMallocStackLoggingEnvName,
	isSafeEnvName,
	isSafeEnvValue,
	isValidEnvName,
	parseEnvFile,
	stripGitRepoLocationEnv,
} from "./dotenv-provenance";
export * from "./test-runtime";
export * from "./worker-host";

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
 * Copy of `env` without its `undefined` slots and without every variable whose value equals the
 * value OMP's own dotenv files (agent dir, config root, `~/.env`) define for that name. Those files
 * hold OMP's credentials; a process that must not see them (a sandboxed one) starts from this.
 *
 * Compares by name and value against the parsed files, so it is stateless and gives the same
 * answer in a worker thread, where the loader found the values already in the process env.
 */
export function stripOmpDotenvEnv(env: Record<string, string | undefined>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const key in env) {
		const value = env[key];
		if (value === undefined) continue;
		if (
			(Object.hasOwn(agentEnv, key) && agentEnv[key] === value) ||
			(Object.hasOwn(piEnv, key) && piEnv[key] === value) ||
			(Object.hasOwn(homeEnv, key) && homeEnv[key] === value)
		) {
			continue;
		}
		result[key] = value;
	}
	return result;
}

// Eagerly parse the user's $HOME/.env and the current project's .env (from cwd)
const homeEnv = parseEnvFile(path.join(os.homedir(), ".env"));
const piEnv = parseEnvFile(path.join(getConfigRootDir(), ".env"));
const agentEnv = parseEnvFile(path.join(getAgentDir(), ".env"));
const projectEnv = parseEnvFile(path.join(getProjectDir(), ".env"));

for (const key of Object.keys(Bun.env)) {
	const value = Bun.env[key];
	if (!isSafeEnvName(key) || isMacosMallocStackLoggingEnvName(key) || value === undefined || !isSafeEnvValue(value)) {
		delete Bun.env[key];
	}
}

/**
 * `OTEL_*` values from OMP's own (non-project) dotenv files: the agent dir,
 * config root, and home `.env`. Those files configure OMP's exporter (endpoint,
 * auth headers, GenAI content capture), so the values are kept here instead of
 * in `Bun.env`/`process.env`: no child process or in-process extension
 * inherits them. Read through {@link $otelEnv}; {@link withOmpOtelEnv} exposes
 * them to the OpenTelemetry SDK for the synchronous span of its construction.
 *
 * Keys are folded with {@link foldOtelEnvName}.
 */
const ompOtelEnvFileValues = new Map<string, string>();

/**
 * Environment names compare case-insensitively on Windows, so a file that spells
 * `otel_exporter_otlp_headers` configures the same variable as the upper-case
 * name; match and key them folded there, exactly on POSIX (names are
 * case-sensitive).
 */
function foldOtelEnvName(name: string, platform: NodeJS.Platform): string {
	return platform === "win32" ? name.toUpperCase() : name;
}

/**
 * @internal Loader seam, exported for tests only. Claims an `OTEL_*` entry from one of OMP's own dotenv files: the value is
 * kept in a private map, never in the process environment. Returns `false` for
 * any other name, which the caller handles as usual.
 *
 * Precedence matches the process-environment loader: a non-empty live value
 * (shell export, project `.env`) wins, and an earlier non-empty file value wins
 * over a later file.
 *
 * @param platform - Name-folding semantics; injectable for tests.
 */
export function claimOmpOtelEnvFileEntry(
	name: string,
	value: string,
	platform: NodeJS.Platform = process.platform,
): boolean {
	const key = foldOtelEnvName(name, platform);
	if (!key.startsWith("OTEL_")) return false;
	if (!Bun.env[name] && !ompOtelEnvFileValues.get(key)) ompOtelEnvFileValues.set(key, value);
	return true;
}

/**
 * `OTEL_*` lookup for OMP's own telemetry: the live environment wins (a shell
 * export or project `.env`), then OMP's own `.env` files. Use this instead of
 * `process.env` for any `OTEL_*` setting OMP reads itself.
 */
export function $otelEnv(name: string): string | undefined {
	const live = Bun.env[name];
	if (live) return live;
	return ompOtelEnvFileValues.get(foldOtelEnvName(name, process.platform)) ?? live;
}

/**
 * Runs `fn` with OMP's `.env`-sourced `OTEL_*` values temporarily present in
 * `process.env` (only for names with no live value), then removes them again in
 * a `finally`. For code that reads the environment itself, such as the
 * OpenTelemetry SDK constructors.
 *
 * Synchronous only: awaiting inside would let other code, including child
 * process spawns, run while the values are set.
 */
export function withOmpOtelEnv<T>(fn: () => T): T {
	const previous = new Map<string, string | undefined>();
	for (const [name, value] of ompOtelEnvFileValues) {
		if (process.env[name]) continue;
		previous.set(name, process.env[name]);
		process.env[name] = value;
	}
	try {
		return fn();
	} finally {
		for (const [name, prior] of previous) {
			if (prior === undefined) delete process.env[name];
			else process.env[name] = prior;
		}
	}
}

for (const file of [projectEnv, agentEnv, piEnv, homeEnv]) {
	for (const key in file) {
		if (isMacosMallocStackLoggingEnvName(key)) continue;
		if (file === projectEnv && Object.hasOwn(OPERATOR_ONLY_ENV_NAMES, key)) continue;
		if (file !== projectEnv && claimOmpOtelEnvFileEntry(key, file[key])) continue;
		if (!Bun.env[key]) {
			Bun.env[key] = file[key];
			if (file === projectEnv) markProjectEnvNameLoadedByOmp(key);
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
