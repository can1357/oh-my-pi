/**
 * Python runtime resolution utilities.
 *
 * Centralizes environment filtering, venv detection, and Python executable resolution
 * for both the shared gateway and local kernel spawning.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { $env, $whichAll, directoryExists, getPythonEnvDir } from "@oh-my-pi/pi-utils";
import { containedEnv } from "../../sandbox/env";
import type { SandboxRuntime } from "../../sandbox/runtime";
import { awaitBoundedProbe, type BoundedProbeResult, type BoundedProbeRunner, probeBound } from "../probe";

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

/** The key `env` stores PATH under: `PATH`, or on Windows whatever casing it already uses. */
export function resolvePathKey(env: Record<string, string | undefined>): string {
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
	// Join (rather than resolve) onto an absolute cwd so the result stays anchored to
	// exactly the cwd given — `path.resolve` would graft the process drive onto a
	// rooted-but-driveless Windows cwd such as `\work`.
	const pythonPath = path.isAbsolute(expanded)
		? expanded
		: path.isAbsolute(cwd)
			? path.join(cwd, expanded)
			: path.resolve(cwd, expanded);
	const venv = detectExplicitVenv(pythonPath);
	if (venv) {
		return { pythonPath, env: applyVenvEnv(baseEnv, venv.venvPath, venv.binDir), venvPath: venv.venvPath };
	}
	return { pythonPath, env: { ...baseEnv } };
}

/**
 * Enumerate candidate Python runtimes in priority order: an active/project venv,
 * the managed `~/.omp/python-env`, then every `python` and `python3` on PATH. Every
 * candidate that physically exists is returned so callers can probe each in turn
 * rather than committing to the first — a managed env left behind by a removed
 * `uv` install, or a version-manager shim with no version selected for the cwd,
 * no longer shadows a working system Python.
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

	for (const systemPath of [...$whichAll("python3"), ...$whichAll("python")]) {
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

/**
 * Directories a contained Python process must read beyond the configured read roots: the staged runner
 * script (when there is one), the virtual environment, and the real interpreter's installation root
 * when recognisable, else its directory (never the symlink's own parent, which can be `~/.local` or
 * `/opt/homebrew`).
 */
export async function pythonReadRoots(runtime: PythonRuntime, scriptPath?: string): Promise<string[]> {
	const roots = scriptPath ? [path.dirname(scriptPath)] : [];
	if (runtime.venvPath) roots.push(runtime.venvPath);
	try {
		roots.push(await interpreterReadRoot(await fs.promises.realpath(runtime.pythonPath)));
	} catch {
		// Unresolvable interpreter: the spawn reports it.
	}
	return roots;
}

/**
 * The installation root of the resolved interpreter `executable` when it is recognisably one, else the
 * executable's own directory, so a `~/bin/python3` never exposes all of home. Candidates, first match wins:
 * - a version manager's shim directory (`shims/`) whose parent holds `versions/` (pyenv) or `installs/`
 *   (asdf): that parent;
 * - POSIX: the parent of the interpreter's directory, holding `pyvenv.cfg` or `lib/python3*`;
 * - Windows: the interpreter's directory, then the parent of a `Scripts` one, holding `Lib` or `python*.dll`.
 * A candidate that is the home directory or an ancestor of it is never the root.
 */
async function interpreterReadRoot(executable: string): Promise<string> {
	const exeDir = path.dirname(executable);
	const parent = path.dirname(exeDir);
	const candidates: Array<{ dir: string; marked: () => Promise<boolean> }> = [];
	if (path.basename(exeDir).toLowerCase() === "shims") {
		candidates.push({
			dir: parent,
			marked: async () =>
				(await directoryExists(path.join(parent, "versions"))) || directoryExists(path.join(parent, "installs")),
		});
	}
	if (process.platform === "win32") {
		candidates.push({ dir: exeDir, marked: () => isWindowsInstallRoot(exeDir) });
		if (path.basename(exeDir).toLowerCase() === "scripts") {
			candidates.push({ dir: parent, marked: () => isWindowsInstallRoot(parent) });
		}
	} else {
		candidates.push({ dir: parent, marked: () => isPosixInstallRoot(parent) });
	}
	for (const { dir, marked } of candidates) {
		if ((await marked()) && !(await containsHome(dir))) return dir;
	}
	return exeDir;
}

/** `dir` holds `pyvenv.cfg` or a `lib/python3*` directory (symlinks followed). */
async function isPosixInstallRoot(dir: string): Promise<boolean> {
	if ((await statOrUndefined(path.join(dir, "pyvenv.cfg")))?.isFile()) return true;
	const lib = path.join(dir, "lib");
	if (!(await directoryExists(lib))) return false;
	for (const name of await fs.promises.readdir(lib).catch(() => [])) {
		if (name.startsWith("python3") && (await directoryExists(path.join(lib, name)))) return true;
	}
	return false;
}

/** `dir` holds a `Lib` directory or a `python*.dll` (symlinks followed). */
async function isWindowsInstallRoot(dir: string): Promise<boolean> {
	if (await directoryExists(path.join(dir, "Lib"))) return true;
	for (const name of await fs.promises.readdir(dir).catch(() => [])) {
		if (/^python.*\.dll$/i.test(name) && (await statOrUndefined(path.join(dir, name)))?.isFile()) return true;
	}
	return false;
}

/** `stat` (symlinks followed), `undefined` when the target is missing or unreadable. */
async function statOrUndefined(target: string): Promise<fs.Stats | undefined> {
	return await fs.promises.stat(target).catch(() => undefined);
}

/** Whether `dir` is the home directory or one of its ancestors (lexically or after resolving symlinks). */
async function containsHome(dir: string): Promise<boolean> {
	const home = os.homedir();
	const homes = [path.resolve(home)];
	try {
		homes.push(await fs.promises.realpath(home));
	} catch {
		// Home missing: the lexical path is all there is to compare.
	}
	return homes.some(candidate => {
		const relative = path.relative(dir, candidate);
		return relative === "" || (relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative));
	});
}

/**
 * Run an interpreter probe inside `sandbox` with no network and `runtime`'s roots readable, so a
 * workspace-controlled interpreter never runs on the host. Same bound/abort/result semantics as
 * `runBoundedProbe`.
 */
async function runContainedProbe(
	sandbox: SandboxRuntime,
	command: string[],
	options: {
		cwd: string;
		env: Record<string, string | undefined>;
		runtime?: PythonRuntime;
		signal?: AbortSignal;
		timeoutMs?: number;
	},
): Promise<BoundedProbeResult> {
	const { cwd, env, runtime, signal, timeoutMs } = options;
	if (signal?.aborted) return { exitCode: null, timedOut: false, aborted: true };
	const child = await sandbox.spawn({
		argv: command,
		cwd,
		env: containedEnv(env),
		extraRead: runtime ? await pythonReadRoots(runtime) : undefined,
		network: "deny",
	});
	child.stdin.end();
	void new Response(child.stdout).arrayBuffer().catch(() => undefined);
	void new Response(child.stderr).arrayBuffer().catch(() => undefined);
	return awaitBoundedProbe(child.exited, () => child.kill(), probeBound(timeoutMs), signal);
}

/**
 * A probe runner that executes each candidate inside `sandbox` (see {@link runContainedProbe}),
 * granting the read roots of the `runtimes` entry whose interpreter is the probed command.
 */
export function containedProbeRunner(
	sandbox: SandboxRuntime,
	cwd: string,
	runtimes: readonly PythonRuntime[],
): BoundedProbeRunner {
	return (command, { env, signal, timeoutMs }) =>
		runContainedProbe(sandbox, command, {
			cwd,
			env,
			runtime: runtimes.find(candidate => candidate.pythonPath === command[0]),
			signal,
			timeoutMs,
		});
}

/**
 * Run `<interpreter> -c <code>` and report whether it exited 0. Under an active OS sandbox the probe runs
 * inside it so a workspace-controlled interpreter never executes on the host; otherwise it runs on the host
 * in `hostCwd` (the process cwd when omitted).
 */
export async function probeInterpreter(
	sandbox: SandboxRuntime | undefined,
	cwd: string,
	candidate: PythonRuntime,
	code: string,
	env: Record<string, string | undefined>,
	hostCwd?: string,
): Promise<boolean> {
	const argv = [candidate.pythonPath, "-c", code];
	if (sandbox) return (await containedProbeRunner(sandbox, cwd, [candidate])(argv, { cwd, env })).exitCode === 0;
	const run = $`${argv}`.env(env).quiet().nothrow();
	return (await (hostCwd === undefined ? run : run.cwd(hostCwd))).exitCode === 0;
}
