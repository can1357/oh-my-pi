export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** True when `value` is a plain JSON object with no own enumerable keys. */
export function isJsonObjectEmpty(value: JsonObject): boolean {
	return Object.keys(value).length === 0;
}
