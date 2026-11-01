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
 * Describes any thrown value as text, and never throws. A value can refuse every
 * conversion: `String()` throws for a null-prototype object, reading an error's
 * `message` can run a getter that throws, and `instanceof` or any read runs a
 * Proxy's traps, which may throw. Such a value is named by
 * `Object.prototype.toString`, or by its type when even that throws or does not
 * return text. Every attempt is checked for a string, because code the value
 * runs can replace the built-ins those attempts call: a conversion can replace
 * `Object.prototype.toString` with a function that returns an object.
 */
export function describeThrown(value: unknown): string {
	try {
		const text = value instanceof Error ? String(value.message) : String(value);
		if (typeof text === "string") return text;
	} catch {
		// Its own conversion threw; the next attempt calls no `toString` or `valueOf` the value defines.
	}
	try {
		const tag: unknown = Object.prototype.toString.call(value);
		if (typeof tag === "string") return tag;
	} catch {
		// A Proxy throws even here.
	}
	// `typeof` runs no code the value or the program defines, so this is always text.
	return `a thrown ${typeof value} that cannot be converted to text`;
}

/** `value` itself when it is an `Error`, otherwise an `Error` that describes it. Never throws. */
export function toError(value: unknown): Error {
	try {
		if (value instanceof Error) return value;
	} catch {
		// A Proxy's `getPrototypeOf` trap threw, so it is not an `Error` that callers can read.
	}
	return new Error(describeThrown(value));
}
