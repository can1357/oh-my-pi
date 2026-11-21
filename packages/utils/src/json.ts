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
 * Index just past the JSON object or array that opens at `text[start]`, or -1
 * when it does not close within `text`. String literals are skipped, honoring
 * escapes, so brackets inside values do not count. Malformed input yields some
 * end that a parser then rejects.
 */
export function jsonContainerEnd(text: string, start: number): number {
	let depth = 0;
	for (let index = start; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === 0x22) {
			for (index++; index < text.length; index++) {
				const inner = text.charCodeAt(index);
				if (inner === 0x5c) index++;
				else if (inner === 0x22) break;
			}
		} else if (code === 0x7b || code === 0x5b) {
			depth++;
		} else if ((code === 0x7d || code === 0x5d) && --depth === 0) {
			return index + 1;
		}
	}
	return -1;
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
	// Fast path: a replacer forces the slow stringify on every call, but
	// bigint payloads are vanishingly rare. Try plain stringify first and
	// retry with the coercing replacer only on TypeError (the only error a
	// bigint raises). A TypeError from elsewhere (circular value, throwing
	// toJSON) recurs on the retry and surfaces from that second walk, so
	// stateful serializers ahead of a bigint run twice on that path.
	try {
		return JSON.stringify(value, undefined, space);
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
		return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item), space);
	}
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
