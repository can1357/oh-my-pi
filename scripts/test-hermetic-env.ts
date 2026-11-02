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
 */

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

/** Non-prefixed names omp reads as aliases of a removed `PI_` variable. */
const ALIASES = [
	// utils/procmgr.ts falls back to it when PI_SHELL_PREFIX is unset.
	"CLAUDE_CODE_SHELL_PREFIX",
];

for (const name of Object.keys(process.env)) {
	if (!name.startsWith("PI_") && !name.startsWith("OMP_")) continue;
	if (KEEP_NAMES[name] === true || KEEP_PREFIXES.some(prefix => name.startsWith(prefix))) continue;
	delete process.env[name];
}
for (const name of ALIASES) delete process.env[name];
