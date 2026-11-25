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

/** Message text of any thrown value: `Error.message` for errors, `String(value)` otherwise. */
export function errorMessage(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

export function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}
