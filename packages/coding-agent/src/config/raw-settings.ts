/**
 * The raw settings tree, as a config file holds it, and the path operations every settings layer
 * shares: the in-process {@link Settings} layers (`./settings`) and the documents of the settings
 * store (`./settings-store`).
 */
import { isRecord } from "@oh-my-pi/pi-utils";

/** Settings tree as a config file stores it: nested records keyed by setting path segment. */
export interface RawSettings {
	[key: string]: unknown;
}

/**
 * Get a nested value from an object by path segments.
 */
export function getByPath(obj: RawSettings, segments: readonly string[]): unknown {
	let current: unknown = obj;
	for (const segment of segments) {
		if (current === null || current === undefined || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

/**
 * Set a nested value in an object by path segments.
 * Creates intermediate objects as needed, replacing whatever non-record (a malformed `[]` included) is in the way.
 */
export function setByPath(obj: RawSettings, segments: readonly string[], value: unknown): void {
	let current = obj;
	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i];
		if (!isRecord(current[segment])) current[segment] = {};
		current = current[segment] as RawSettings;
	}
	current[segments[segments.length - 1]] = value;
}

/**
 * Assign `obj[key]` as an own property. Plain assignment of a parsed
 * `__proto__` key (an agent name, say) would replace the prototype instead,
 * silently dropping that entry.
 */
export function setOwn(obj: RawSettings, key: string, value: unknown): void {
	if (key === "__proto__") {
		Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
	} else {
		obj[key] = value;
	}
}

/**
 * Removes the value at `segments`, pruning the parent objects the removal leaves empty. Every record on the
 * path below `obj` is replaced by a copy rather than edited: a merged view or a cached read may share it.
 */
export function deleteByPath(obj: RawSettings, segments: readonly string[]): void {
	const containers: RawSettings[] = [obj];
	for (let i = 0; i < segments.length - 1; i++) {
		const next = containers[i][segments[i]];
		if (!isRecord(next)) return;
		containers.push(next);
	}
	if (!Object.hasOwn(containers[containers.length - 1], segments[containers.length - 1])) return;
	let replacement: RawSettings | undefined;
	for (let i = containers.length - 1; i >= 0; i--) {
		const container = i === 0 ? obj : { ...containers[i] };
		if (replacement) container[segments[i]] = replacement;
		else delete container[segments[i]];
		replacement = Object.keys(container).length > 0 ? container : undefined;
	}
}

/** Whether `prefix` is `segments` or the path of one of its ancestors. */
export function isPathPrefix(prefix: readonly string[], segments: readonly string[]): boolean {
	return prefix.length <= segments.length && prefix.every((segment, i) => segment === segments[i]);
}

/**
 * Deep equality of setting values that, unlike `Bun.deepEquals`, also compares the key order of
 * plain objects: record order breaks ties between equal-length model patterns (`edit.modelVariants`,
 * `systemPromptTemplates`), so a reorder is a change. Values other than plain objects and arrays
 * compare with `Bun.deepEquals`.
 */
export function settingValuesEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (!settingValuesEqual(a[i], b[i])) return false;
		return true;
	}
	if (!isPlainObject(a) || !isPlainObject(b)) return Bun.deepEquals(a, b);
	// Positional key comparison needs `b`'s keys materialized; `a` streams.
	const otherKeys = Object.keys(b);
	let index = 0;
	for (const key in a) {
		if (key !== otherKeys[index++] || !settingValuesEqual(a[key], b[key])) return false;
	}
	return index === otherKeys.length;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
