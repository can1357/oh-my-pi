/**
 * An environment map without its `undefined` slots. A contained process inherits nothing, so
 * callers pass the complete environment explicitly; `process.env`/`Bun.env` carry `undefined`
 * entries that the spawn rejects.
 */
export function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
	return out;
}
