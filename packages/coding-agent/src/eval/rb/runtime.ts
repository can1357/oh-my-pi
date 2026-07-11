/**
 * Ruby runtime resolution utilities.
 *
 * Resolves the Ruby interpreter for the local kernel and filters the
 * environment to a safe allowlist before exposing it to user cell code. Much
 * simpler than the Python sibling — Ruby has no venv layout to detect — but it
 * mirrors the same allowlist/denylist + explicit-interpreter shape.
 */
import { createEnvFilter, enumerateRuntimes, resolveExplicitPath, resolveRuntime } from "../runtime-env";

const DEFAULT_ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LC_MESSAGES",
	"TERM",
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION",
	"TMPDIR",
	"TEMP",
	"TMP",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_RUNTIME_DIR",
	"SSH_AUTH_SOCK",
	"SSH_AGENT_PID",
	"LD_LIBRARY_PATH",
	"DYLD_LIBRARY_PATH",
];

const WINDOWS_ENV_ALLOWLIST = [
	"APPDATA",
	"COMPUTERNAME",
	"COMSPEC",
	"HOMEDRIVE",
	"HOMEPATH",
	"LOCALAPPDATA",
	"NUMBER_OF_PROCESSORS",
	"OS",
	"PATH",
	"PATHEXT",
	"PROCESSOR_ARCHITECTURE",
	"PROCESSOR_IDENTIFIER",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PROGRAMW6432",
	"SESSIONNAME",
	"SYSTEMDRIVE",
	"SYSTEMROOT",
	"TEMP",
	"TMP",
	"USERDOMAIN",
	"USERPROFILE",
	"USERNAME",
	"WINDIR",
];

const DEFAULT_ENV_DENYLIST = [
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"GOOGLE_API_KEY",
	"GEMINI_API_KEY",
	"OPENROUTER_API_KEY",
	"PERPLEXITY_API_KEY",
	"PERPLEXITY_COOKIES",
	"EXA_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"MISTRAL_API_KEY",
];

// Ruby version managers and gem layout live behind these prefixes; passing them
// through lets `bundle`/`gem`/rbenv/asdf-shimmed code resolve consistently.
const DEFAULT_ENV_ALLOW_PREFIXES = ["LC_", "XDG_", "PI_", "GEM_", "BUNDLE", "RBENV_", "RUBY", "CHRUBY_", "ASDF_"];

export interface RubyRuntime {
	/** Path to the ruby executable. */
	rubyPath: string;
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
 * Resolve an explicitly configured interpreter (`ruby.interpreter`) into a
 * runtime, bypassing discovery. Does not probe the executable — callers must
 * check it actually runs. `~` expands to the home directory and relative paths
 * resolve against `cwd`.
 */
export function resolveExplicitRubyRuntime(
	interpreter: string,
	cwd: string,
	baseEnv: Record<string, string | undefined>,
): RubyRuntime {
	const rubyPath = resolveExplicitPath(interpreter, cwd);
	return { rubyPath, env: { ...baseEnv } };
}

/**
 * Enumerate candidate Ruby runtimes in priority order. With an explicit
 * interpreter that is the only candidate; otherwise the first `ruby` on PATH.
 */
export function enumerateRubyRuntimes(
	cwd: string,
	baseEnv: Record<string, string | undefined>,
	interpreter?: string,
): RubyRuntime[] {
	return enumerateRuntimes(cwd, baseEnv, "ruby", (rubyPath, env) => ({ rubyPath, env }), interpreter);
}

/**
 * Resolve the highest-priority Ruby runtime. Throws when none exists.
 */
export function resolveRubyRuntime(
	cwd: string,
	baseEnv: Record<string, string | undefined>,
	interpreter?: string,
): RubyRuntime {
	return resolveRuntime(cwd, baseEnv, "ruby", (rubyPath, env) => ({ rubyPath, env }), interpreter);
}
