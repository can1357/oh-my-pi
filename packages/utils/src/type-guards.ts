import { describeError, errorClassOf } from "./thrown";

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
 * `value` itself when its prototype chain leads to a built-in error class,
 * otherwise an `Error` whose message describes it ({@link describeError}).
 * Never throws, and ends on a Proxy whose prototype chain never does.
 */
export function toError(value: unknown): Error {
	if (errorClassOf(value) !== undefined) return value as Error;
	return new Error(describeError(value).message);
}
