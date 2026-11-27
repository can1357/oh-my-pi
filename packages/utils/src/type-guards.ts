export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Reads an own string-valued property without invoking accessors. */
export function stringProperty(value: object, key: string): string | undefined {
	const field = Object.getOwnPropertyDescriptor(value, key)?.value;
	return typeof field === "string" ? field : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}

/** `value` when it is a non-empty string, else `undefined`. */
export function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Message text of a thrown value: `Error.message` for errors, `String(value)` otherwise.
 * `String()` can itself throw (a null-prototype object, a throwing `toString`); that error propagates.
 */
export function errorMessage(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

export function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}
