/**
 * Strip ANSI escape sequences, remove control characters / lone surrogates,
 * and normalize line endings.
 *
 * Bun-native implementation of the former native `sanitizeText` (see
 * `crates/pi-natives/src/text.rs::sanitize_text`). JavaScript strings are
 * already UTF-16 code-unit arrays. `toWellFormed()` handles the uncommon
 * malformed path; when it changes the input, replacement characters are
 * dropped and the normalized result goes through the well-formed sanitizer.
 *
 * Fast path: well-formed input with no controls or ANSI returns the original
 * string after the control probe.
 */

import { isRecord } from "./type-guards";

const ESC_CHAR = "\x1b";

// Well-formed strings only need control/ANSI detection: C0 (excl. \t \n),
// CR, DEL, and C1. ESC (0x1B) is in \x0B-\x1F.
const CONTROL_RE = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;

const REPLACEMENT_CHAR = "\ufffd";

export function sanitizeText(text: string): string {
	const wellFormed = text.toWellFormed();
	if (wellFormed !== text) {
		return sanitizeWellFormedText(wellFormed.replaceAll(REPLACEMENT_CHAR, ""));
	}
	return sanitizeWellFormedText(text);
}

function sanitizeWellFormedText(text: string): string {
	CONTROL_RE.lastIndex = 0;
	if (CONTROL_RE.exec(text) === null) return text;

	const stripped = text.indexOf(ESC_CHAR) === -1 ? text : Bun.stripANSI(text);
	CONTROL_RE.lastIndex = 0;
	return stripped.replace(CONTROL_RE, "");
}

/**
 * Apply {@link sanitizeText} to every string value inside a JSON-shaped value.
 * Only plain objects and arrays are walked; class instances, typed arrays, and
 * cyclic back-references pass through untouched. Object keys are kept as-is.
 *
 * Returns the input reference when nothing changed, so reference-keyed caches
 * stay warm; changed containers are copied and the input is never mutated.
 * The iterative walk also handles arbitrarily deep tool-result `details`
 * without exhausting the TUI's call stack.
 */
export function sanitizeTextDeep(value: unknown): unknown {
	if (typeof value === "string") return sanitizeText(value);
	const root = sanitizerFrame(value);
	if (!root) return value;
	const stack: SanitizerFrame[] = [root];
	const ancestors = new Set<object>([root.value]);
	while (true) {
		const frame = stack[stack.length - 1]!;
		const length = frame.kind === "array" ? frame.value.length : frame.keys.length;
		if (frame.index === length) {
			const clean = frame.copy ?? frame.value;
			ancestors.delete(frame.value);
			stack.pop();
			if (stack.length === 0) return clean;
			acceptSanitizedValue(stack[stack.length - 1]!, clean);
			continue;
		}
		const child = frame.kind === "array" ? frame.value[frame.index++] : frame.value[frame.keys[frame.index++]!];
		if (typeof child === "string") {
			acceptSanitizedValue(frame, sanitizeText(child));
			continue;
		}
		if (child === null || typeof child !== "object" || ancestors.has(child)) continue;
		const next = sanitizerFrame(child);
		if (!next) continue;
		ancestors.add(child);
		stack.push(next);
	}
}

type SanitizerFrame =
	| { kind: "array"; value: unknown[]; index: number; copy?: unknown[] }
	| { kind: "record"; value: Record<string, unknown>; keys: string[]; index: number; copy?: Record<string, unknown> };

function sanitizerFrame(value: unknown): SanitizerFrame | undefined {
	if (Array.isArray(value)) return { kind: "array", value, index: 0 };
	if (!isRecord(value)) return undefined;
	const proto: unknown = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return undefined;
	return { kind: "record", value, keys: Object.keys(value), index: 0 };
}

function acceptSanitizedValue(frame: SanitizerFrame, clean: unknown): void {
	if (frame.kind === "array") {
		const index = frame.index - 1;
		if (clean !== frame.value[index]) (frame.copy ??= frame.value.slice())[index] = clean;
		return;
	}
	const key = frame.keys[frame.index - 1]!;
	if (clean === frame.value[key]) return;
	const copy = (frame.copy ??= { ...frame.value });
	if (key === "__proto__") {
		Object.defineProperty(copy, key, { value: clean, writable: true, enumerable: true, configurable: true });
	} else {
		copy[key] = clean;
	}
}

/**
 * Escape the three XML-significant characters (`&`, `<`, `>`) in text destined
 * for an XML/markup element body. Allocation-conscious: returns the input
 * unchanged (same reference) when nothing needs escaping. Quotes are left as-is
 * — use it for element text, not attribute values.
 */
export function escapeXmlText(input: string): string {
	let firstEscapable = -1;
	for (let index = 0; index < input.length; index++) {
		const char = input.charCodeAt(index);
		if (char === 38 || char === 60 || char === 62) {
			firstEscapable = index;
			break;
		}
	}
	if (firstEscapable === -1) return input;

	let output = input.slice(0, firstEscapable);
	for (let index = firstEscapable; index < input.length; index++) {
		const char = input[index];
		if (char === "&") output += "&amp;";
		else if (char === "<") output += "&lt;";
		else if (char === ">") output += "&gt;";
		else output += char;
	}
	return output;
}

/**
 * Escape XML-significant characters for an attribute VALUE: the three body
 * characters (`&`, `<`, `>`) plus the double quote (`"` → `&quot;`) that would
 * otherwise close the attribute. Allocation-conscious: returns the input
 * unchanged (same reference) when nothing needs escaping. Use it for attribute
 * values; {@link escapeXmlText} is for element bodies and leaves `"` intact.
 */
export function escapeXmlAttribute(input: string): string {
	let firstEscapable = -1;
	for (let index = 0; index < input.length; index++) {
		const char = input.charCodeAt(index);
		if (char === 38 || char === 60 || char === 62 || char === 34) {
			firstEscapable = index;
			break;
		}
	}
	if (firstEscapable === -1) return input;

	let output = input.slice(0, firstEscapable);
	for (let index = firstEscapable; index < input.length; index++) {
		const char = input[index];
		if (char === "&") output += "&amp;";
		else if (char === "<") output += "&lt;";
		else if (char === ">") output += "&gt;";
		else if (char === '"') output += "&quot;";
		else output += char;
	}
	return output;
}
