import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getConfigRootDir, refreshDirsFromEnv } from "./dirs";

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

/** Filters process env for child shells without launch-cwd dotenv values. */
export function filterChildShellEnv(
	env: Record<string, string | undefined>,
	cwd: string = process.cwd(),
): Record<string, string> {
	const result = filterProcessEnv(env);
	const projectEnv = parseEnvFile(path.join(cwd, ".env"));
	const launchNodeEnv = launchEnvValues ? launchEnvValues.get("NODE_ENV") : env.NODE_ENV;
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
	if (!launchEnvValues && nodeEnvName !== ".env.development") {
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
	for (const key in allLaunchEnv) {
		const launchValue = launchEnvValues?.get(key);
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
		if (launchEnvValues || projectEnvNamesLoadedByOmp.has(key)) {
			// Strong provenance: the launch environment is known and this name is
			// absent from it, or OMP itself injected the value — either way it came
			// from a project dotenv file, not the parent shell.
			delete result[key];
		} else if (
			result[key] === launchEnv[key] ||
			result[key] === expandedLaunchEnv[key] ||
			result[key] === fallbackLaunchEnv?.[key] ||
			result[key] === expandedFallbackLaunchEnv?.[key]
		) {
			// No launch-env snapshot (dotenv autoloaded without procfs): best-effort
			// value match against the Bun-parsed dotenv.
			delete result[key];
		}
	}
	return result;
}

/**
 * Parse one dotenv line with Bun-compatible semantics: an optional `export`
 * prefix, full-line `#` comments, inline `#` comments after whitespace on
 * unquoted values, and single/double/backtick quoting (a `#` inside quotes
 * stays literal). Returns undefined for blank lines, comments, and malformed
 * names.
 */
function parseEnvLine(line: string): { key: string; value: string } | undefined {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith("#")) return undefined;
	const eqIndex = trimmed.indexOf("=");
	if (eqIndex === -1) return undefined;
	let key = trimmed.slice(0, eqIndex).trim();
	const exported = key.match(/^export[ \t]+(.*)$/);
	if (exported) key = exported[1].trim();
	if (!isValidEnvName(key)) return undefined;
	const raw = trimmed.slice(eqIndex + 1).replace(/^[ \t]+/, "");
	const quote = raw[0];
	if (quote === '"' || quote === "'" || quote === "`") {
		let close = raw.indexOf(quote, 1);
		while (close !== -1 && raw[close - 1] === "\\") close = raw.indexOf(quote, close + 1);
		return { key, value: close === -1 ? raw.slice(1) : raw.slice(1, close) };
	}
	const commentIndex = raw.search(/[ \t]#/);
	return { key, value: (commentIndex === -1 ? raw : raw.slice(0, commentIndex)).trimEnd() };
}

/**
 * Parses a .env file synchronously into key-value string pairs using
 * {@link parseEnvLine} for Bun-compatible line semantics, then mirrors valid
 * `OMP_` variables to their `PI_` aliases.
 */
export function parseEnvFile(filePath: string): Record<string, string> {
	const result: Record<string, string> = {};
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		for (const line of content.split("\n")) {
			const parsed = parseEnvLine(line);
			if (parsed && isSafeEnvValue(parsed.value)) result[parsed.key] = parsed.value;
		}
	} catch {
		// File doesn't exist or can't be read - return empty result
	}

	// OMP_ overrides PI_
	for (const k in result) {
		if (k.startsWith("OMP_")) {
			result[`PI_${k.slice(4)}`] = result[k];
		}
	}

	return result;
}

// Eagerly parse the user's $HOME/.env and the current project's .env (from cwd)
const homeEnv = parseEnvFile(path.join(os.homedir(), ".env"));
const piEnv = parseEnvFile(path.join(getConfigRootDir(), ".env"));
const agentEnv = parseEnvFile(path.join(getAgentDir(), ".env"));
const projectEnv = parseEnvFile(path.join(process.cwd(), ".env"));

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

const BUN_TEST_ENTRY_PATTERN = /[._](?:test|spec)\.[cm]?[jt]sx?$/;

/** True when the process is an explicitly marked test child or Bun is running a test entrypoint. */
export function isBunTestRuntime(): boolean {
	if (Bun.env.PI_TEST_RUNTIME === "1") return true;
	const hasTestEnvironment = Bun.env.BUN_ENV === "test" || Bun.env.NODE_ENV === "test";
	return hasTestEnvironment && BUN_TEST_ENTRY_PATTERN.test(Bun.main);
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
