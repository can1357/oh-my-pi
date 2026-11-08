/**
 * Runtime helpers shared by the closure validators (`closures.ts`) and the
 * generated ones (`codegen.ts`): JSON value equality, `uniqueItems`,
 * `multipleOf`, code-point string length, and the pattern cache.
 */

const hasOwn = Object.hasOwn;

/** JSON equality: numbers by value, arrays by order, objects by key set regardless of order. */
export function jsonEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	const array = Array.isArray(a);
	if (array !== Array.isArray(b)) return false;
	if (array) {
		const left = a as unknown[];
		const right = b as unknown[];
		if (left.length !== right.length) return false;
		for (let index = 0; index < left.length; index++) if (!jsonEqual(left[index], right[index])) return false;
		return true;
	}
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	let count = 0;
	for (const key in left) {
		if (!hasOwn(left, key)) continue;
		if (!hasOwn(right, key) || !jsonEqual(left[key], right[key])) return false;
		count++;
	}
	for (const key in right) if (hasOwn(right, key)) count--;
	return count === 0;
}

/** True when `values` contains `value` under {@link jsonEqual}. */
export function jsonIncludes(values: readonly unknown[], value: unknown): boolean {
	for (const candidate of values) if (jsonEqual(candidate, value)) return true;
	return false;
}

/** `uniqueItems`: no two elements are {@link jsonEqual}. */
export function uniqueItems(items: readonly unknown[]): boolean {
	const n = items.length;
	if (n < 2) return true;
	let primitive = true;
	for (let index = 0; index < n; index++) {
		const item = items[index];
		if (typeof item === "object" && item !== null) {
			primitive = false;
			break;
		}
	}
	// SameValueZero matches JSON equality for primitives (0 equals -0).
	if (primitive && n > 16) return new Set(items).size === n;
	for (let i = 1; i < n; i++) {
		const item = items[i];
		for (let j = 0; j < i; j++) {
			if (primitive ? item === items[j] : jsonEqual(item, items[j])) return false;
		}
	}
	return true;
}

/**
 * `multipleOf` with float tolerance: `0.0075` is a multiple of `0.0001` even
 * though the IEEE quotient is `74.99999999999999`. An overflowing quotient is
 * a multiple only when `divisor` divides 1 (every integer is a multiple of 0.5).
 */
export function isMultipleOf(value: number, divisor: number): boolean {
	const quotient = value / divisor;
	if (Number.isInteger(quotient)) return true;
	if (!Number.isFinite(quotient)) return Number.isInteger(value) && Number.isInteger(1 / divisor);
	return Math.abs(quotient - Math.round(quotient)) <= Number.EPSILON * Math.abs(quotient);
}

/** String length in Unicode code points, as `minLength`/`maxLength` count it. */
export function codePointLength(value: string): number {
	let length = value.length;
	for (let index = 0; index < value.length - 1; index++) {
		const high = value.charCodeAt(index);
		if (high < 0xd800 || high > 0xdbff) continue;
		const low = value.charCodeAt(index + 1);
		if (low >= 0xdc00 && low <= 0xdfff) {
			length--;
			index++;
		}
	}
	return length;
}

const patterns = new Map<string, RegExp>();
const PATTERN_CACHE_LIMIT = 1024;

/**
 * Compile a JSON Schema `pattern` as an ECMAScript regex with the `u` flag,
 * falling back to legacy syntax for patterns that only parse without it.
 * Regexes are stateless (no `g`/`y`), so equal sources share one instance.
 *
 * # Errors
 * Throws `SyntaxError` when the source is not a regular expression at all.
 */
export function compilePattern(source: string): RegExp {
	let regex = patterns.get(source);
	if (regex !== undefined) return regex;
	try {
		regex = new RegExp(source, "u");
	} catch {
		regex = new RegExp(source);
	}
	if (patterns.size >= PATTERN_CACHE_LIMIT) patterns.clear();
	patterns.set(source, regex);
	return regex;
}

/** Property names inherited by plain objects; reading them needs an own-property check. */
export function isInheritedName(key: string): boolean {
	return key in Object.prototype;
}
