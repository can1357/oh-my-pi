/**
 * Python runtime resolution utilities.
 *
 * Centralizes environment filtering, venv detection, and Python executable resolution
 * for both the shared gateway and local kernel spawning.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $env, $which, getPythonEnvDir } from "@oh-my-pi/pi-utils";

const DEFAULT_ENV_ALLOWLIST = new Set([
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
	"CONDA_PREFIX",
	"CONDA_DEFAULT_ENV",
	"VIRTUAL_ENV",
	"PYTHONPATH",
	"LD_LIBRARY_PATH",
]);

const WINDOWS_ENV_ALLOWLIST = new Set([
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
	"USERDOMAIN_ROAMINGPROFILE",
	"USERPROFILE",
	"USERNAME",
	"WINDIR",
]);

const DEFAULT_ENV_DENYLIST = new Set([
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
]);

const DEFAULT_ENV_ALLOW_PREFIXES = ["LC_", "XDG_", "PI_"];

const CASE_INSENSITIVE_ENV = process.platform === "win32";
const BASE_ENV_ALLOWLIST = new Set([...DEFAULT_ENV_ALLOWLIST, ...WINDOWS_ENV_ALLOWLIST]);

const NORMALIZED_ALLOWLIST = new Set(
	Array.from(BASE_ENV_ALLOWLIST, key => (CASE_INSENSITIVE_ENV ? key.toUpperCase() : key)),
);
const NORMALIZED_DENYLIST = new Set(
	Array.from(DEFAULT_ENV_DENYLIST, key => (CASE_INSENSITIVE_ENV ? key.toUpperCase() : key)),
);
const NORMALIZED_ALLOW_PREFIXES = CASE_INSENSITIVE_ENV
	? DEFAULT_ENV_ALLOW_PREFIXES.map(prefix => prefix.toUpperCase())
	: DEFAULT_ENV_ALLOW_PREFIXES;

function normalizeEnvKey(key: string): string {
	return CASE_INSENSITIVE_ENV ? key.toUpperCase() : key;
}

function resolvePathKey(env: Record<string, string | undefined>): string {
	if (!CASE_INSENSITIVE_ENV) return "PATH";
	const match = Object.keys(env).find(candidate => candidate.toLowerCase() === "path");
	return match ?? "PATH";
}

function resolveManagedPythonEnv(): string {
	return getPythonEnvDir();
}

function resolveManagedPythonCandidate(): { venvPath: string; pythonPath: string } {
	const venvPath = resolveManagedPythonEnv();
	const binDir = process.platform === "win32" ? path.join(venvPath, "Scripts") : path.join(venvPath, "bin");
	const pythonPath = path.join(binDir, process.platform === "win32" ? "python.exe" : "python");
	return { venvPath, pythonPath };
}

export interface PythonRuntime {
	/** Path to python executable */
	pythonPath: string;
	/** Filtered environment variables */
	env: Record<string, string | undefined>;
	/** Path to virtual environment, if detected */
	venvPath?: string;
}

/**
 * Filter environment variables to a safe allowlist for Python subprocesses.
 * Removes sensitive API keys and limits to known-safe variables.
 */
export function filterEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
	const filtered: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		const normalizedKey = normalizeEnvKey(key);
		if (NORMALIZED_DENYLIST.has(normalizedKey)) continue;
		if (NORMALIZED_ALLOWLIST.has(normalizedKey)) {
			const destKey = normalizedKey === "PATH" ? "PATH" : key;
			filtered[destKey] = value;
			continue;
		}
		if (NORMALIZED_ALLOW_PREFIXES.some(prefix => normalizedKey.startsWith(prefix))) {
			filtered[key] = value;
		}
	}
	return filtered;
}

/**
 * Detect virtual environment path from VIRTUAL_ENV or common locations.
 */
export function resolveVenvPath(cwd: string): string | undefined {
	if ($env.VIRTUAL_ENV) return $env.VIRTUAL_ENV;
	if ($env.CONDA_PREFIX) return $env.CONDA_PREFIX;
	const candidates = [path.join(cwd, ".venv"), path.join(cwd, "venv")];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

/**
 * Apply a venv-style PATH/VIRTUAL_ENV layout onto a fresh copy of `baseEnv` for
 * the interpreter living in `binDir`.
 */
function applyVenvEnv(
	baseEnv: Record<string, string | undefined>,
	venvPath: string,
	binDir: string,
): Record<string, string | undefined> {
	const env = { ...baseEnv };
	env.VIRTUAL_ENV = venvPath;
	const pathKey = resolvePathKey(env);
	const currentPath = env[pathKey];
	env[pathKey] = currentPath ? `${binDir}${path.delimiter}${currentPath}` : binDir;
	return env;
}

function venvBinDir(venvPath: string): string {
	return process.platform === "win32" ? path.join(venvPath, "Scripts") : path.join(venvPath, "bin");
}

function detectExplicitVenv(pythonPath: string): { venvPath: string; binDir: string } | undefined {
	const binDir = path.dirname(pythonPath);
	const venvPath = path.dirname(binDir);
	if (fs.existsSync(path.join(venvPath, "pyvenv.cfg"))) {
		return { venvPath, binDir };
	}
	return undefined;
}

/**
 * Resolve an explicitly configured interpreter (`python.interpreter`) into a
 * runtime, bypassing discovery. Does not probe or validate the executable —
 * callers must check it actually runs. `~` expands to the home directory and
 * relative paths resolve against `cwd`. When the interpreter sits inside a
 * virtualenv (a `pyvenv.cfg` above its bin dir), the venv activation env is
 * applied so subprocesses and `pip` resolve consistently.
 */
export function resolveExplicitPythonRuntime(
	interpreter: string,
	cwd: string,
	baseEnv: Record<string, string | undefined>,
): PythonRuntime {
	const expanded =
		interpreter === "~"
			? os.homedir()
			: interpreter.startsWith("~/")
				? path.join(os.homedir(), interpreter.slice(2))
				: interpreter;
	const pythonPath = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
	const venv = detectExplicitVenv(pythonPath);
	if (venv) {
		return { pythonPath, env: applyVenvEnv(baseEnv, venv.venvPath, venv.binDir), venvPath: venv.venvPath };
	}
	return { pythonPath, env: { ...baseEnv } };
}

/**
 * Enumerate candidate Python runtimes in priority order: an active/project venv,
 * the managed `~/.omp/python-env`, then the system interpreter on PATH. Every
 * candidate that physically exists is returned so callers can probe each in turn
 * rather than committing to the first — a managed env left behind by a removed
 * `uv` install no longer shadows a working system Python.
 */
export function enumeratePythonRuntimes(cwd: string, baseEnv: Record<string, string | undefined>): PythonRuntime[] {
	const runtimes: PythonRuntime[] = [];
	const seen = new Set<string>();
	const push = (runtime: PythonRuntime): void => {
		if (seen.has(runtime.pythonPath)) return;
		seen.add(runtime.pythonPath);
		runtimes.push(runtime);
	};

	const venvPath = baseEnv.VIRTUAL_ENV ?? resolveVenvPath(cwd);
	if (venvPath) {
		const binDir = venvBinDir(venvPath);
		const pythonCandidate = path.join(binDir, process.platform === "win32" ? "python.exe" : "python");
		if (fs.existsSync(pythonCandidate)) {
			push({ pythonPath: pythonCandidate, env: applyVenvEnv(baseEnv, venvPath, binDir), venvPath });
		}
	}

	const managed = resolveManagedPythonCandidate();
	if (fs.existsSync(managed.pythonPath)) {
		const managedBin = path.dirname(managed.pythonPath);
		push({
			pythonPath: managed.pythonPath,
			env: applyVenvEnv(baseEnv, managed.venvPath, managedBin),
			venvPath: managed.venvPath,
		});
	}

	const systemPath = $which("python") ?? $which("python3");
	if (systemPath) {
		push({ pythonPath: systemPath, env: { ...baseEnv } });
	}

	return runtimes;
}

/**
 * Resolve the highest-priority Python runtime. Prefer {@link enumeratePythonRuntimes}
 * when you can probe candidates; this returns only the first one and throws when
 * no interpreter exists.
 */
export function resolvePythonRuntime(cwd: string, baseEnv: Record<string, string | undefined>): PythonRuntime {
	const [runtime] = enumeratePythonRuntimes(cwd, baseEnv);
	if (!runtime) {
		throw new Error("Python executable not found on PATH");
	}
	return runtime;
}
