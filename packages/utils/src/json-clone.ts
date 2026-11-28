/**
 * Deep copies of JSON-shaped values. The module uses no Node API, so a browser
 * client imports it (`@oh-my-pi/pi-utils/json-clone`) without the package root.
 */

function isPlainObject(val: object): val is Record<string, unknown> {
	return Object.getPrototypeOf(val) === Object.prototype || Array.isArray(val);
}

export function structuredCloneJSON<T>(value: T): T {
	// primitives|null|undefined, copy
	if (!value || typeof value !== "object") {
		return value;
	}

	// deep clone
	if (isPlainObject(value)) {
		try {
			return structuredClone(value);
		} catch {
			// might still fail due to nested structures
		}
	}
	return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Deep-copies a JSON-shaped tree (arrays and plain or null-prototype objects)
 * so later mutation of the source can never reach the copy. Strings and other
 * primitives are immutable and shared, so the cost is O(containers) instead of
 * `structuredClone`'s O(bytes) — the difference matters for hot paths that
 * re-copy large string payloads (e.g. streamed tool-call arguments) per delta.
 *
 * Copies own enumerable string keys only. Any other object (class instance,
 * Date, Map, inherited-prototype object) is copied with {@link structuredCloneJSON}.
 * Not cycle-safe: callers MUST pass acyclic data, as any JSON-serializable value is.
 */
export function cloneJsonTree<T>(value: T): T {
	return cloneJsonNode(value) as T;
}

function isJsonRecord(value: object): value is Record<string, unknown> {
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function cloneJsonNode(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(cloneJsonNode);
	if (!isJsonRecord(value)) return structuredCloneJSON(value);
	const out: Record<string, unknown> = {};
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		const child = cloneJsonNode(value[key]);
		// Assigning `__proto__` would swap the copy's prototype instead of
		// creating the own data property JSON.parse produces.
		if (key === "__proto__") {
			Object.defineProperty(out, key, { value: child, enumerable: true, writable: true, configurable: true });
		} else {
			out[key] = child;
		}
	}
	return out;
}
