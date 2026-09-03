/**
 * Try to parse JSON, returning null on failure.
 */
export function tryParseJson<T = unknown>(content: string): T | null {
	try {
		return JSON.parse(content) as T;
	} catch {
		return null;
	}
}

/**
 * Serialize JSON while preserving bigint precision as decimal strings.
 *
 * Tool arguments normally arrive from JSON providers, but extension hooks and
 * host integrations can supply JavaScript bigint values. Native
 * `JSON.stringify` throws for those values, which makes otherwise valid agent
 * history impossible to persist, replay, or compact. A decimal string is the
 * only lossless JSON representation.
 */
export function stringifyJson(value: unknown, space?: string | number): string | undefined {
	return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item), space);
}

function stableJsonClone(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableJsonClone);
	if (value !== null && typeof value === "object") {
		const sorted = Object.create(null) as Record<string, unknown>;
		for (const key of Object.keys(value).sort()) {
			sorted[key] = stableJsonClone(Reflect.get(value, key));
		}
		return sorted;
	}
	return value;
}

/**
 * Deterministically serialize JSON-shaped data by sorting object keys at every
 * depth while preserving array order. Throws for values JSON cannot represent
 * as a top-level value instead of returning an easy-to-misuse undefined.
 */
export function stableStringifyJson(value: unknown): string {
	const serialized = JSON.stringify(stableJsonClone(value));
	if (serialized === undefined) throw new TypeError("Value is not JSON-serializable");
	return serialized;
}
