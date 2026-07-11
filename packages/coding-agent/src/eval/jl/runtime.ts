/**
 * Julia runtime resolution utilities.
 */
import { createEnvFilter, enumerateRuntimes, resolveExplicitPath, resolveRuntime } from "../runtime-env";

const DEFAULT_ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"USER",
	"USERNAME",
	"LOGNAME",
	"SHELL",
	"TERM",
	"LANG",
	"SYSTEMROOT",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
	"TEMP",
	"TMP",
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION",
	"SSH_AUTH_SOCK",
	"SSH_AGENT_PID",
	"SSH_CONNECTION",
	"SSH_CLIENT",
	"SSH_TTY",
	"DISPLAY",
	"XAUTHORITY",
	"TZ",
	"LD_LIBRARY_PATH",
	"DYLD_LIBRARY_PATH",
];

const WINDOWS_ENV_ALLOWLIST = [
	"ALLUSERSPROFILE",
	"APPDATA",
	"COMMONPROGRAMFILES",
	"COMMONPROGRAMFILES(X86)",
	"COMMONPROGRAMW6432",
	"COMPUTERNAME",
	"HOMEDRIVE",
	"HOMEPATH",
	"LOCALAPPDATA",
	"NUMBER_OF_PROCESSORS",
	"OS",
	"PROCESSOR_ARCHITECTURE",
	"PROCESSOR_IDENTIFIER",
	"PROCESSOR_LEVEL",
	"PROCESSOR_REVISION",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PROGRAMW6432",
	"PUBLIC",
	"SESSIONNAME",
	"SYSTEMDRIVE",
	"USERDOMAIN",
	"USERDOMAIN_ROAMING_PC",
	"USERPROFILE",
];

const DEFAULT_ENV_DENYLIST = ["PI_API_KEY", "PI_TOKEN", "PI_PASSWORD", "PI_SESSION", "PI_TOOL_BRIDGE_TOKEN"];

// Julia version managers and package layout live behind these prefixes; passing them
// through lets Julia discover packages and configure its runtime consistently.
const DEFAULT_ENV_ALLOW_PREFIXES = ["LC_", "XDG_", "PI_", "JULIA_", "OPENBLAS_", "MKL_"];

export interface JuliaRuntime {
	/** Path to the julia executable. */
	juliaPath: string;
	/** Filtered environment variables. */
	env: Record<string, string | undefined>;
}

export const filterEnv = createEnvFilter({
	allowList: DEFAULT_ENV_ALLOWLIST,
	windowsAllowList: WINDOWS_ENV_ALLOWLIST,
	denyList: DEFAULT_ENV_DENYLIST,
	allowPrefixes: DEFAULT_ENV_ALLOW_PREFIXES,
});

/**
 * Resolve an explicitly configured interpreter (`julia.interpreter`) into a
 * runtime, bypassing discovery. Does not probe the executable.
 * `~` expands to the home directory and relative paths resolve against `cwd`.
 */
export function resolveExplicitJuliaRuntime(
	interpreter: string,
	cwd: string,
	baseEnv: Record<string, string | undefined>,
): JuliaRuntime {
	const juliaPath = resolveExplicitPath(interpreter, cwd);
	return { juliaPath, env: { ...baseEnv } };
}

/**
 * Enumerate candidate Julia runtimes in priority order. With an explicit
 * interpreter that is the only candidate; otherwise the first `julia` on PATH.
 */
export function enumerateJuliaRuntimes(
	cwd: string,
	baseEnv: Record<string, string | undefined>,
	interpreter?: string,
): JuliaRuntime[] {
	return enumerateRuntimes(cwd, baseEnv, "julia", (juliaPath, env) => ({ juliaPath, env }), interpreter);
}

/**
 * Resolve the highest-priority Julia runtime. Throws when none exists.
 */
export function resolveJuliaRuntime(
	cwd: string,
	baseEnv: Record<string, string | undefined>,
	interpreter?: string,
): JuliaRuntime {
	return resolveRuntime(cwd, baseEnv, "julia", (juliaPath, env) => ({ juliaPath, env }), interpreter);
}
