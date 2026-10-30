/**
 * Preloaded by every `bun test` in this repository. Each directory a test run starts in
 * names it in its own bunfig.toml, because Bun reads only the bunfig.toml of that directory.
 *
 * It marks every process a test spawns as a test child (`PI_TEST_RUNTIME=1`, which
 * `isBunTestRuntime()` in @oh-my-pi/pi-utils reads). A test file's own process is recognised
 * by its entrypoint, but a child such as an omp CLI has a production entrypoint. Unmarked, it
 * uses the auth broker and the telemetry collector that the developer's shell names, with the
 * developer's token. ci-test-ts.ts starts `bun test` with the marker already set, so every
 * child inherits it; a direct `bun test` has no such launcher, so this sets it instead.
 *
 * Bun hands a child one of two environments. `process.env` reaches the children of
 * `node:child_process` and `Bun.$`, and any call that passes `env: { ...process.env }`. A
 * `Bun.spawn` or `Bun.spawnSync` call without `env` passes the environment Bun started with,
 * which writing `process.env` does not change; for those calls the default becomes that same
 * starting environment plus the marker. A call that builds its `env` from nothing, or that
 * removes the marker to run a child as production, still decides for itself, and must keep
 * the developer's broker variables, `OTEL_*` collector and home directory from that child.
 */

const TEST_RUNTIME_MARKER = "PI_TEST_RUNTIME";

process.env[TEST_RUNTIME_MARKER] = "1";
// Taken before any test runs: the environment Bun started with, plus the marker just set.
const defaultChildEnv: Record<string, string | undefined> = { ...process.env };

interface EnvOption {
	env?: Record<string, string | undefined>;
}

function withDefaultChildEnv<T extends EnvOption>(options: T): T {
	return options.env === undefined ? { ...options, env: defaultChildEnv } : options;
}

const spawn = Bun.spawn;
const spawnSync = Bun.spawnSync;
// One implementation cannot restate Bun's overloads, so each wrapper is cast to the type of
// the function it forwards to: it fills in an omitted `env` and passes everything else as is.
Object.assign(Bun, {
	spawn: ((command: string[] | (EnvOption & { cmd: string[] }), options?: EnvOption) =>
		Array.isArray(command)
			? spawn(command, withDefaultChildEnv(options ?? {}))
			: spawn(withDefaultChildEnv(command))) as unknown as typeof Bun.spawn,
	spawnSync: ((command: string[] | (EnvOption & { cmd: string[] }), options?: EnvOption) =>
		Array.isArray(command)
			? spawnSync(command, withDefaultChildEnv(options ?? {}))
			: spawnSync(withDefaultChildEnv(command))) as unknown as typeof Bun.spawnSync,
});
