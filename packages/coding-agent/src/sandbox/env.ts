import { stripGitRepoLocationEnv, stripOmpDotenvEnv } from "@oh-my-pi/pi-utils";
import type { SandboxRuntime } from "./runtime";
import type { SandboxNetworkMode } from "./types";

/**
 * Proxy variables MXC sets inside the container in `allowlist` mode (its egress proxy; bubblewrap
 * sets `FTP_PROXY` too).
 */
const PROXY_ENV_RE = /^(?:https?|ftp|all|no)_proxy$/i;
/** The temp dir variables every contained process gets pointed at the runtime's private temp dir. */
const TEMP_ENV_KEYS = ["TMPDIR", "TMP", "TEMP"] as const;
const TEMP_ENV_RE = /^(?:tmpdir|tmp|temp)$/i;

/**
 * An environment map without its `undefined` slots (`process.env`/`Bun.env` carry them). Not a
 * spawn env for a contained process: those start from {@link containedEnv}.
 */
export function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
	return out;
}

/**
 * The environment every contained process starts from: `base` without its `undefined` slots and
 * without the variables omp loaded from its own `.env` files (agent dir, config root, `~/.env`),
 * which carry omp's credentials and are unreadable inside the container anyway. `explicit` (an MCP
 * server's `env`, the kernel's own settings, …) is layered on top unchanged.
 */
export function containedEnv(
	base: Record<string, string | undefined>,
	explicit?: Record<string, string | undefined>,
): Record<string, string> {
	const env = stripOmpDotenvEnv(base);
	if (explicit) Object.assign(env, definedEnv(explicit));
	return env;
}

/**
 * {@link containedEnv} from omp's own environment (`Bun.env`), also without the git repo location
 * variables (`GIT_DIR`, `GIT_WORK_TREE`, …) omp inherited from its launcher: they would point
 * contained git at another repository. `explicit` may still set them.
 */
export function inheritedContainedEnv(explicit?: Record<string, string | undefined>): Record<string, string> {
	const base = definedEnv(Bun.env);
	stripGitRepoLocationEnv(base);
	return containedEnv(base, explicit);
}

/**
 * `env` with `TMPDIR`/`TMP`/`TEMP` set to `tempDir`. On Windows, where variable names are
 * case-insensitive, other spellings of them (`Temp`) are dropped first: the child's environment
 * block would carry both, and either could win.
 */
export function withSandboxTempDir(
	env: Record<string, string>,
	tempDir: string,
	platform: NodeJS.Platform = process.platform,
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (platform !== "win32" || !TEMP_ENV_RE.test(key)) result[key] = value;
	}
	for (const key of TEMP_ENV_KEYS) result[key] = tempDir;
	return result;
}

/**
 * `env` for a process contained by `runtime` (host, shell session, PTY): in `allowlist` mode
 * (effective, or `network` when a request overrides it) the parent's proxy variables are dropped so
 * MXC's egress proxy applies; in `allow`/`deny` mode they pass through (a proxy-only network still
 * needs them under `allow`). `TMPDIR`/`TMP`/`TEMP` always name the runtime's private temp dir
 * ({@link withSandboxTempDir}). Starts from the given `env` as is; {@link containedProcessEnv} builds
 * it from {@link containedEnv}.
 */
export function sandboxProcessEnv(
	runtime: Pick<SandboxRuntime, "status" | "tempDir">,
	env: Record<string, string>,
	network?: SandboxNetworkMode,
): Record<string, string> {
	const status = runtime.status();
	const effective = network ?? (status.state === "active" ? status.network : undefined);
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (effective !== "allowlist" || !PROXY_ENV_RE.test(key)) result[key] = value;
	}
	// Last, so neither the parent env nor the shell config can point them back: the system temp
	// dir is not writable in the container, the runtime's private one is.
	return withSandboxTempDir(result, runtime.tempDir());
}

/** {@link sandboxProcessEnv} of {@link containedEnv}`(base, explicit)`: a contained process's whole env. */
export function containedProcessEnv(
	runtime: Pick<SandboxRuntime, "status" | "tempDir">,
	base: Record<string, string | undefined>,
	explicit?: Record<string, string | undefined>,
	network?: SandboxNetworkMode,
): Record<string, string> {
	return sandboxProcessEnv(runtime, containedEnv(base, explicit), network);
}
