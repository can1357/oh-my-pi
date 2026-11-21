import { stripOmpDotenvEnv } from "@oh-my-pi/pi-utils";
import type { SandboxRuntime } from "./runtime";
import type { SandboxNetworkMode } from "./types";

/** Proxy variables MXC sets inside the container in `allowlist` mode (its egress proxy). */
const PROXY_ENV_RE = /^(?:https?|all|no)_proxy$/i;

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
 * `env` for a process contained by `runtime` (host, shell session, PTY): in `allowlist` mode
 * (effective, or `network` when a request overrides it) the parent's proxy variables are dropped so
 * MXC's egress proxy applies; in `allow`/`deny` mode they pass through (a proxy-only network still
 * needs them under `allow`). `TMPDIR`/`TMP`/`TEMP` always name the runtime's private temp dir.
 * Starts from the given `env` as is; {@link containedProcessEnv} builds it from {@link containedEnv}.
 */
export function sandboxProcessEnv(
	runtime: SandboxRuntime,
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
	const tempDir = runtime.tempDir();
	result.TMPDIR = tempDir;
	result.TMP = tempDir;
	result.TEMP = tempDir;
	return result;
}

/** {@link sandboxProcessEnv} of {@link containedEnv}`(base, explicit)`: a contained process's whole env. */
export function containedProcessEnv(
	runtime: SandboxRuntime,
	base: Record<string, string | undefined>,
	explicit?: Record<string, string | undefined>,
	network?: SandboxNetworkMode,
): Record<string, string> {
	return sandboxProcessEnv(runtime, containedEnv(base, explicit), network);
}
