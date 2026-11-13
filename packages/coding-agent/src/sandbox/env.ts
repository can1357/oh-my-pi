import { stripOmpDotenvEnv } from "@oh-my-pi/pi-utils";

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
	if (explicit) {
		for (const [key, value] of Object.entries(explicit)) if (value !== undefined) env[key] = value;
	}
	return env;
}
