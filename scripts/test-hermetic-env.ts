/**
 * `bun test` preload (wired by each package's `bunfig.toml` and the root one):
 * a test never sees the invoking user's omp environment.
 *
 * omp reads `PI_*` / `OMP_*` variables to overlay user config (`PI_CONFIG_FILES`),
 * relocate it (`PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR`, `PI_PROFILE`/`OMP_PROFILE`)
 * and change behaviour (`PI_SHELL_PREFIX`, `PI_NO_PTY`, stream timeouts, proxies,
 * TUI probes, auth broker, ...). omp's own bash tool exports several of them
 * (`PI_CONFIG_FILES`, `PI_SESSION_FILE`, `PI_SHELL_PREFIX`, ...), so a suite run
 * from inside omp would otherwise test the user's setup instead of the code.
 *
 * Default-deny: every `PI_` / `OMP_` name is removed, so a variable omp starts
 * reading later is covered without touching this file. Kept are only the
 * controls a test run sets on purpose: the runner's own knobs, opt-in suites,
 * and the location of the native addon build under test. Tests that exercise a
 * variable set it themselves.
 *
 * More routes reach the user's environment, and all are closed here:
 * - `Bun.spawn` / `Bun.spawnSync` without `env` give the child the environment
 *   the process launched with, not `process.env` (bun-types: "Changes to
 *   `process.env` at runtime won't automatically be reflected in the default
 *   value"). Such calls get the launch environment with this file's changes.
 * - A worker's own `Bun.spawn` and `new Worker` start from that same launch
 *   environment, and `new Worker(url)` without options does too. Every global
 *   `Worker` therefore gets this file as a `preload`, which installs the same
 *   replacements inside it, and an options object. `node:worker_threads`'
 *   Worker starts from `process.env` itself, but its ESM export cannot be
 *   replaced from a preload, so its own children are not covered; nothing in
 *   this repository constructs it.
 * - A Bun process a test starts loads the `.env` of its working directory again
 *   before any of its code runs, putting back a removed name the directory's
 *   `.env` sets. `BUN_OPTIONS=--no-env-file` reaches every such process through
 *   the environment it inherits; the names that `.env` gave this process are
 *   in that environment already, and an explicit `--env-file` still loads.
 * - `packages/utils/src/env.ts` fills absent names from `~/.env`, the config
 *   root's `.env`, the agent dir's `.env` and the working directory's `.env`.
 *   `PI_TEST_INVOKING_HOME` and `PI_TEST_INVOKING_CWD` tell it which home and
 *   directory the run started from, so it skips those files while a test still
 *   runs there with its default dirs.
 *
 * A test that names no agent dir gets an empty one of its own through
 * `PI_CODING_AGENT_DIR`, so it reads no settings, context files, skills or
 * credentials from the user's `~/.omp/agent`. HOME stays: suites use tool caches
 * under it (Puppeteer's browser download, rustup, Python user packages). A test
 * that needs a particular agent dir sets its own, as before.
 */

import { afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const KEEP_PREFIXES = [
	// Test-harness controls: PI_TEST_RUNTIME, PI_TEST_NO_NATIVES, OMP_TEST_SHARD, OMP_TEST_VISIBLE_BROWSER, ...
	"PI_TEST_",
	"OMP_TEST_",
	// Opt-in live end-to-end suites (gateway URL, model ids).
	"OMP_E2E_",
];

const KEEP_NAMES: Record<string, true> = {
	// Opt-in suites gated on the developer's machine.
	PI_PYTHON_INTEGRATION: true,
	PI_LOCAL_LLM: true,
	PI_NO_LOCAL_LLM: true,
	// Which native addon build the tests load (build selection, not user config).
	PI_NATIVES_DIR: true,
	PI_NATIVE_VARIANT: true,
	OMP_NATIVE_LIBRARY_PATH: true,
	// Runner knob read by scripts/ci-test-ts.ts.
	OMP_FORCE_RUST_TASKS: true,
};

/** Names outside `PI_` / `OMP_` that omp reads and that point it at the user's own setup. */
const USER_NAMES = [
	// utils/procmgr.ts falls back to them when PI_SHELL_PREFIX, PI_BASH_NO_CI, PI_BASH_NO_LOGIN are unset.
	"CLAUDE_CODE_SHELL_PREFIX",
	"CLAUDE_BASH_NO_CI",
	"CLAUDE_BASH_NO_LOGIN",
	// Relocate a config omp discovers: Claude (config/claude-paths.ts) and Copilot
	// (discovery/helpers.ts). A test that isolates HOME would otherwise still read the user's tree
	// through them. GH_CONFIG_DIR and GLAB_CONFIG_DIR stay: without them a test that does not isolate
	// HOME would read the user's gh/glab login under ~/.config instead of the one the shell chose.
	"CLAUDE_CONFIG_DIR",
	"COPILOT_HOME",
	// Relocate omp's own dirs (utils/dirs.ts) and XDG-based configs off HOME.
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
];

function isRemoved(enumerated: string): boolean {
	// Windows reads environment names in any case but enumerates them as spelled.
	const name = process.platform === "win32" ? enumerated.toUpperCase() : enumerated;
	if (USER_NAMES.includes(name)) return true;
	if (!name.startsWith("PI_") && !name.startsWith("OMP_")) return false;
	return KEEP_NAMES[name] !== true && !KEEP_PREFIXES.some(prefix => name.startsWith(prefix));
}

// Inside a worker started by the Worker replacements below, `process.env` is already the test's
// cleaned one (or an `env` the test chose); only the replacements are installed there.
const inWorker = !Bun.isMainThread;
const launchEnv: Record<string, string | undefined> = { ...process.env };
if (!inWorker) {
	for (const name of Object.keys(process.env)) {
		if (!isRemoved(name)) continue;
		delete process.env[name];
		delete launchEnv[name];
	}
	process.env.PI_TEST_INVOKING_HOME = os.homedir();
	process.env.PI_TEST_INVOKING_CWD = process.cwd();
	launchEnv.PI_TEST_INVOKING_HOME = process.env.PI_TEST_INVOKING_HOME;
	launchEnv.PI_TEST_INVOKING_CWD = process.env.PI_TEST_INVOKING_CWD;
	process.env.BUN_OPTIONS = [process.env.BUN_OPTIONS, "--no-env-file"].filter(Boolean).join(" ");
	launchEnv.BUN_OPTIONS = process.env.BUN_OPTIONS;

	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-test-agent-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	launchEnv.PI_CODING_AGENT_DIR = agentDir;
	// `bun test` emits no process "exit" a preload can observe; a preload's afterAll runs once the
	// files this process ran are done (once per file under --parallel isolation).
	afterAll(() => fs.rmSync(agentDir, { recursive: true, force: true }));
}

type SpawnOptions = { env?: unknown };

/** Supplies the cleaned launch environment to a spawn call that names none, in either call form. */
function withLaunchEnv(args: unknown[]): unknown[] {
	const [first, ...rest] = args;
	if (Array.isArray(first)) {
		const [options, ...tail] = rest as [SpawnOptions | undefined, ...unknown[]];
		return options?.env === undefined ? [first, { ...options, env: launchEnv }, ...tail] : args;
	}
	const options = first as SpawnOptions;
	return options.env === undefined ? [{ ...options, env: launchEnv }, ...rest] : args;
}

const spawn = Bun.spawn;
const spawnSync = Bun.spawnSync;
// Both have call overloads a rest-argument wrapper cannot spell; it forwards every argument unchanged
// except a missing `env`.
Bun.spawn = ((...args: unknown[]) => Reflect.apply(spawn, Bun, withLaunchEnv(args))) as unknown as typeof Bun.spawn;
Bun.spawnSync = ((...args: unknown[]) =>
	Reflect.apply(spawnSync, Bun, withLaunchEnv(args))) as unknown as typeof Bun.spawnSync;

/** Options that run this preload in the worker too, and never leave the worker on the launch env. */
function withSelfPreload(options: WorkerOptions | undefined): WorkerOptions {
	const preload = options?.preload === undefined ? [] : [options.preload].flat();
	return { ...options, preload: [import.meta.path, ...preload] };
}

const LaunchWorker = globalThis.Worker;
globalThis.Worker = class Worker extends LaunchWorker {
	constructor(url: string | URL, options?: WorkerOptions) {
		super(url, withSelfPreload(options));
	}
};
