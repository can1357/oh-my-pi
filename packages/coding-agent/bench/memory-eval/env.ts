import { normalizeEnvKey } from "@oh-my-pi/pi-utils";

/** `env` without the variables whose names start with `prefix`, matched the way the OS matches names. */
export function envWithout(prefix: string, env: Record<string, string | undefined> = Bun.env): Record<string, string> {
	const kept: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined && !normalizeEnvKey(key).startsWith(prefix)) kept[key] = value;
	}
	return kept;
}
