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
 * Two more routes reach the user's environment, and both are closed here:
 * - `Bun.spawn` / `Bun.spawnSync` without `env` give the child the environment
 *   the process launched with, not `process.env` (bun-types: "Changes to
 *   `process.env` at runtime won't automatically be reflected in the default
 *   value"). Such calls get the launch environment with this file's changes.
 * - `packages/utils/src/env.ts` fills absent names from `~/.env`, the config
 *   root's `.env` and the agent dir's `.env`. `PI_TEST_INVOKING_HOME` tells it
 *   which home is the user's, so it skips those files while a test still runs
 *   with that home and its default dirs.
 */

import * as os from "node:os";

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

function isRemoved(name: string): boolean {
	if (USER_NAMES.includes(name)) return true;
	if (!name.startsWith("PI_") && !name.startsWith("OMP_")) return false;
	return KEEP_NAMES[name] !== true && !KEEP_PREFIXES.some(prefix => name.startsWith(prefix));
}

const launchEnv: Record<string, string | undefined> = { ...process.env };
for (const name of Object.keys(process.env)) {
	if (!isRemoved(name)) continue;
	delete process.env[name];
	delete launchEnv[name];
}
process.env.PI_TEST_INVOKING_HOME = os.homedir();
launchEnv.PI_TEST_INVOKING_HOME = process.env.PI_TEST_INVOKING_HOME;

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
