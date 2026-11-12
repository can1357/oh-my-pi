export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined };
export type JsonRecord = { [key: string]: JsonValue | undefined };

/** Deep-walk an object, transforming all string values. */
export function deepWalkStrings<T>(obj: T, transform: (s: string) => string): T {
	if (typeof obj === "string") {
		return transform(obj) as unknown as T;
	}
	if (Array.isArray(obj)) {
		let changed = false;
		const result = obj.map(item => {
			const transformed = deepWalkStrings(item, transform);
			if (transformed !== item) changed = true;
			return transformed;
		});
		return (changed ? result : obj) as unknown as T;
	}
	if (obj !== null && typeof obj === "object" && isPlainRecord(obj)) {
		let changed = false;
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(obj)) {
			const value = (obj as Record<string, unknown>)[key];
			const transformed = deepWalkStrings(value, transform);
			if (transformed !== value) changed = true;
			result[key] = transformed;
		}
		return (changed ? result : obj) as T;
	}
	return obj;
}

function isPlainRecord(obj: object): obj is Record<string, unknown> {
	const prototype = Object.getPrototypeOf(obj);
	return prototype === Object.prototype || prototype === null;
}

/** Visit every string value in JSON data, keys excluded. */
export function forEachJsonString(value: JsonValue, visit: (text: string) => void): void {
	if (typeof value === "string") {
		visit(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const child of value) forEachJsonString(child, visit);
		return;
	}
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) {
			if (child !== undefined) forEachJsonString(child, visit);
		}
	}
}

/**
 * Map string values in schema-designated JSON data: tool arguments, discovery
 * annotations, and schema examples. Keys remain identifiers. Protocol
 * objects and JSON Schema structure require their own typed traversal.
 */
export function mapJsonStrings(value: JsonValue, fn: (s: string) => string): JsonValue {
	if (typeof value === "string") return fn(value);
	if (Array.isArray(value)) {
		let out: JsonValue[] | undefined;
		for (let index = 0; index < value.length; index++) {
			const item = value[index]!;
			const next = mapJsonStrings(item, fn);
			if (next === item) continue;
			out ??= value.slice();
			out[index] = next;
		}
		return out ?? value;
	}
	if (value !== null && typeof value === "object") {
		let out: JsonRecord | undefined;
		for (const key in value) {
			if (!Object.hasOwn(value, key)) continue;
			const item = value[key];
			if (item === undefined) continue;
			const next = mapJsonStrings(item, fn);
			if (next === item) continue;
			out ??= { ...value };
			out[key] = next;
		}
		return out ?? value;
	}
	return value;
}
