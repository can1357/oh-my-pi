import { describeError, isErrorValue } from "./thrown";

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

/**
 * `value` itself when it is an error ({@link isErrorValue}), otherwise an
 * `Error` whose message describes it ({@link describeError}). Never throws, and
 * ends on a Proxy whose prototype chain never does.
 */
export function toError(value: unknown): Error {
	if (isErrorValue(value)) return value;
	return new Error(describeError(value).message);
}
