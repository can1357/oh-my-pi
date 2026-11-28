import { isBigIntObject, isBooleanObject, isNumberObject, isStringObject } from "node:util/types";
import { ContainerPairPath, isStackOverflow, type NestedWalk, nestsDeeperThan, runNested } from "./nested-walk";
import { isJsonRecord, isNonNullObject } from "./type-guards";

/**
 * Try to parse JSON, returning null on failure.
 */
export function tryParseJson<T = unknown>(content: string): T | null {
	try {
		return JSON.parse(content) as T;
	} catch {
		return null;
	}
}

/**
 * Index just past the JSON object or array that opens at `text[start]`, or -1
 * when it does not close within `text`. String literals are skipped, honoring
 * escapes, so brackets inside values do not count. Malformed input yields some
 * end that a parser then rejects.
 */
export function jsonContainerEnd(text: string, start: number): number {
	let depth = 0;
	for (let index = start; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === 0x22) {
			for (index++; index < text.length; index++) {
				const inner = text.charCodeAt(index);
				if (inner === 0x5c) index++;
				else if (inner === 0x22) break;
			}
		} else if (code === 0x7b || code === 0x5b) {
			depth++;
		} else if ((code === 0x7d || code === 0x5d) && --depth === 0) {
			return index + 1;
		}
	}
	return -1;
}

/**
 * Serialize JSON while preserving bigint precision as decimal strings.
 *
 * Tool arguments normally arrive from JSON providers, but extension hooks and
 * host integrations can supply JavaScript bigint values. Native
 * `JSON.stringify` throws for those values, which makes otherwise valid agent
 * history impossible to persist, replay, or compact. A decimal string is the
 * only lossless JSON representation.
 */
export function stringifyJson(value: unknown, space?: string | number): string | undefined {
	// Fast path: a replacer forces the slow stringify on every call, but
	// bigint payloads are vanishingly rare. Try plain stringify first and
	// retry with the coercing replacer only on TypeError (the only error a
	// bigint raises). A TypeError from elsewhere (circular value, throwing
	// toJSON) recurs on the retry and surfaces from that second walk, so
	// stateful serializers ahead of a bigint run twice on that path.
	try {
		return JSON.stringify(value, undefined, space);
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
		return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item), space);
	}
}

/** What {@link stringifyDeepJson} and {@link stringifyJsonIteratively} write that `JSON.stringify` does not. */
export interface DeepJsonOptions {
	/** Write a bigint as its decimal string, as {@link stringifyJson} does, where `JSON.stringify` throws. */
	readonly bigintAsString?: boolean;
}

/** {@link DeepJsonOptions} of {@link stringifyDeepJson}, which can also indent. */
export interface DeepJsonTextOptions extends DeepJsonOptions {
	/**
	 * `JSON.stringify`'s `space`. A value nested past {@link INDENTED_JSON_LEVELS}
	 * levels is written without indentation: indented, a value's text grows with
	 * the square of its depth (30,000 levels is a 1.8 GB string).
	 */
	readonly space?: string | number;
	/**
	 * Check the depth first: a value nested past {@link DEEP_JSON_LEVELS}
	 * levels is written by {@link stringifyJsonIteratively} at once, without
	 * the 1.5 s or more Bun's `JSON.stringify` spends running out of stack on
	 * a value 40,000 levels deep. The check ({@link nestsDeeperThan}) costs one
	 * step per object or array, so it is for a caller that writes the same
	 * kind of value again and again (a page of messages, a request's
	 * telemetry), not one that knows the depth. It calls no getter or `toJSON`,
	 * so a value nested that deep only below one is written as without the
	 * check: by `JSON.stringify` until it runs out of stack.
	 */
	readonly probeDepth?: boolean;
	/**
	 * The caller already knows the value is deep, from a walk of its own or one
	 * check for several writes: it goes to {@link stringifyJsonIteratively} at
	 * once, without the depth check or a `JSON.stringify` attempt.
	 */
	readonly deep?: boolean;
}

/** {@link DeepJsonOptions} of {@link stringifyJsonIteratively}, which can also stop early. */
export interface IterativeJsonOptions extends DeepJsonOptions {
	/**
	 * Stop once the text passes `limit` characters: the result is then the
	 * start of the JSON, longer than `limit` (the member that passed it is
	 * written whole), for a label that shows only a value's head; a text no
	 * longer than `limit` is written whole.
	 */
	readonly limit?: number;
}

/** Levels past which {@link stringifyDeepJson} writes a value without the indentation it was asked for. */
export const INDENTED_JSON_LEVELS = 1_000;

/**
 * Levels past which a value is written by {@link stringifyJsonIteratively}:
 * Bun's `JSON.stringify` takes milliseconds below them, seconds past about
 * 25,000 levels, and runs out of stack at 40,000, while `JSON.parse` reads
 * millions (it does not recurse).
 */
export const DEEP_JSON_LEVELS = 10_000;

/**
 * `JSON.stringify(value)` ({@link stringifyJson} with `bigintAsString`), also
 * for a value nested deeper than the engine's recursion allows (Bun's throws a
 * `RangeError` at 40,000 levels, while its `JSON.parse` reads millions): on
 * that stack overflow ({@link isStackOverflow}) the value is written again by
 * {@link stringifyJsonIteratively}, which gives the same bytes, so the getters
 * and `toJSON` methods ahead of the overflow run twice on that path. Any value
 * `JSON.stringify` writes gets its result, and any other error is its own,
 * a `RangeError` the value's code throws (a `toJSON`, a getter) included:
 * that value is not written again. With `deep`, and with `space` a value
 * nested past {@link INDENTED_JSON_LEVELS} levels and with `probeDepth` one
 * nested past {@link DEEP_JSON_LEVELS} ({@link nestsDeeperThan}), it goes to
 * {@link stringifyJsonIteratively} directly, without indentation; any other is
 * written (and indented) as `JSON.stringify` writes it.
 */
export function stringifyDeepJson(value: unknown, options?: DeepJsonTextOptions): string | undefined {
	if (options?.deep) return stringifyJsonIteratively(value, options);
	const space = options?.space;
	const levels = space !== undefined ? INDENTED_JSON_LEVELS : options?.probeDepth ? DEEP_JSON_LEVELS : undefined;
	if (levels !== undefined && nestsDeeperThan(value, levels)) return stringifyJsonIteratively(value, options);
	try {
		return options?.bigintAsString ? stringifyJson(value, space) : JSON.stringify(value, undefined, space);
	} catch (error) {
		if (!isStackOverflow(error)) throw error;
		return stringifyJsonIteratively(value, options);
	}
}

/** An object or array {@link stringifyJsonIteratively} is writing. */
interface JsonContainerFrame {
	readonly container: object;
	/** The object's keys, in the order `JSON.stringify` writes them; undefined for an array. */
	readonly keys: string[] | undefined;
	/** How many keys or elements it has. */
	readonly length: number;
	/** The next key or element to write. */
	index: number;
	/** Whether a member was written, so the next one follows a comma. */
	written: boolean;
}

/** Pieces {@link stringifyJsonIteratively} joins into one chunk of its text. */
const JSON_PIECES_PER_CHUNK = 1024;

/**
 * `JSON.stringify(value)` with no replacer and no indent, written with an
 * explicit stack instead of recursion, so a value of any depth serializes.
 * It walks objects and arrays as `JSON.stringify` does: each value's
 * `toJSON(key)` first, an object's keys in `Object.keys` order, an array's
 * `length` converted to a whole number first (a proxy can report any value),
 * `undefined`, a function and a symbol left out of an object and written
 * `null` in an array, and a cycle a `TypeError`. It writes every other value
 * as `JSON.stringify` does, without calling its `toJSON` a second time
 * ({@link scalarJson}): a boxed primitive, told by its internal slot as that
 * function tells it, is unwrapped, a bigint throws that function's
 * `TypeError` (with `bigintAsString`, a bigint primitive is its decimal string
 * instead, as {@link stringifyJson} writes it), and a string, number, boolean
 * or `null` is written by `JSON.stringify` itself. It takes several times as
 * long as `JSON.stringify` on a shallow value, but Bun's slows with depth:
 * {@link stringifyDeepJson} runs this writer where `JSON.stringify` runs out
 * of stack, and a caller that knows a value is deep can call it directly.
 * With `limit`, it stops once the text passes that many characters.
 */
export function stringifyJsonIteratively(value: unknown, options?: IterativeJsonOptions): string | undefined {
	const bigintAsString = options?.bigintAsString === true;
	const limit = options?.limit ?? Number.POSITIVE_INFINITY;
	const root = jsonValueOf(value, "");
	if (!isJsonContainer(root)) return scalarJson(root, bigintAsString);
	// The text so far: chunks of joined pieces, and the pieces since, so the engine holds a few
	// long strings instead of one short string per value (millions for a long session's tree).
	const chunks: string[] = [];
	let parts: string[] = [];
	let length = 0;
	const write = (piece: string): void => {
		length += piece.length;
		parts.push(piece);
		if (parts.length < JSON_PIECES_PER_CHUNK) return;
		chunks.push(parts.join(""));
		parts = [];
	};
	const stack: JsonContainerFrame[] = [];
	const open = new Set<object>();
	// Keys repeat across the objects of one value (every entry of a tree has the same ones).
	const quotedKeys = new Map<string, string>();
	const prefix = (frame: JsonContainerFrame, key: string): string => {
		const comma = frame.written ? "," : "";
		if (!frame.keys) return comma;
		let quoted = quotedKeys.get(key);
		if (quoted === undefined) {
			quoted = JSON.stringify(key);
			quotedKeys.set(key, quoted);
		}
		return `${comma}${quoted}:`;
	};
	const enter = (container: object): void => {
		if (open.has(container)) throw new TypeError("JSON.stringify cannot serialize cyclic structures.");
		open.add(container);
		if (Array.isArray(container)) {
			stack.push({ container, keys: undefined, length: jsonArrayLength(container), index: 0, written: false });
			write("[");
		} else {
			const keys = Object.keys(container);
			stack.push({ container, keys, length: keys.length, index: 0, written: false });
			write("{");
		}
	};
	enter(root);
	while (stack.length > 0 && length <= limit) {
		const frame = stack[stack.length - 1]!;
		if (frame.index === frame.length) {
			write(frame.keys ? "}" : "]");
			open.delete(frame.container);
			stack.pop();
			continue;
		}
		const key = frame.keys ? frame.keys[frame.index]! : String(frame.index);
		frame.index++;
		const member = jsonValueOf(Reflect.get(frame.container, key), key);
		if (isJsonContainer(member)) {
			write(prefix(frame, key));
			frame.written = true;
			enter(member);
			continue;
		}
		const text = scalarJson(member, bigintAsString);
		if (text === undefined && frame.keys) continue;
		write(prefix(frame, key) + (text ?? "null"));
		frame.written = true;
	}
	chunks.push(parts.join(""));
	return chunks.join("");
}

/** `value` after its `toJSON(key)`, as `JSON.stringify` serializes it under `key`. */
function jsonValueOf(value: unknown, key: string): unknown {
	if (value === null || (typeof value !== "object" && typeof value !== "function" && typeof value !== "bigint")) {
		return value;
	}
	// Read as `JSON.stringify` reads it: a bigint's on its prototype, with the bigint as the receiver.
	const toJSON: unknown =
		typeof value === "bigint" ? Reflect.get(Object(value), "toJSON", value) : Reflect.get(value, "toJSON");
	return typeof toJSON === "function" ? Reflect.apply(toJSON, value, [key]) : value;
}

/**
 * Whether `JSON.stringify` writes `value` as an object or an array: an object
 * that is neither callable nor a boxed number, string, boolean or bigint, told
 * by the internal slot as `JSON.stringify` tells it (so a box from another
 * realm, or one whose prototype changed, is still a box). A boxed symbol is an
 * object to it.
 */
function isJsonContainer(value: unknown): value is object {
	return (
		typeof value === "object" &&
		value !== null &&
		!(isNumberObject(value) || isStringObject(value) || isBooleanObject(value) || isBigIntObject(value))
	);
}

/**
 * The text `JSON.stringify` writes for `value`, a value after its `toJSON`
 * that is not an object or array to it ({@link isJsonContainer}): `undefined`
 * for `undefined`, a function or a symbol; a boxed primitive unwrapped by its
 * internal slot (a number and a string converted, so through an overridden
 * `valueOf` or `toString`); a bigint a `TypeError`, or with `bigintAsString`
 * a bigint primitive its decimal string, as {@link stringifyJson}'s replacer
 * writes it (a boxed bigint still throws there). Its `toJSON` is not called
 * again, as `JSON.stringify(value)` would call it.
 */
function scalarJson(value: unknown, bigintAsString: boolean): string | undefined {
	if (bigintAsString && typeof value === "bigint") return JSON.stringify(value.toString());
	let primitive = value;
	// Unary plus is the ToNumber `JSON.stringify` applies: `Number()` would convert a bigint
	// an overridden `valueOf` returns, where ToNumber throws.
	if (isNumberObject(value)) primitive = +value;
	else if (isStringObject(value)) primitive = String(value);
	else if (isBooleanObject(value)) primitive = Boolean.prototype.valueOf.call(value);
	else if (isBigIntObject(value)) primitive = BigInt.prototype.valueOf.call(value);
	if (typeof primitive === "bigint") throw new TypeError("JSON.stringify cannot serialize BigInt.");
	if (primitive === undefined || typeof primitive === "function" || typeof primitive === "symbol") return undefined;
	return JSON.stringify(primitive);
}

/** `array.length` as `JSON.stringify` reads it (ToLength), for a proxy that reports a length that is not a whole number. */
function jsonArrayLength(array: readonly unknown[]): number {
	// Unary plus is ToNumber, which throws for a bigint where `Number()` converts it.
	return Math.min(Math.max(Math.trunc(+array.length) || 0, 0), Number.MAX_SAFE_INTEGER);
}

function stableJsonClone(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableJsonClone);
	if (value !== null && typeof value === "object") {
		const sorted = Object.create(null) as Record<string, unknown>;
		for (const key of Object.keys(value).sort()) {
			sorted[key] = stableJsonClone(Reflect.get(value, key));
		}
		return sorted;
	}
	return value;
}

/**
 * Deterministically serialize JSON-shaped data by sorting object keys at every
 * depth while preserving array order. Throws for values JSON cannot represent
 * as a top-level value instead of returning an easy-to-misuse undefined.
 */
export function stableStringifyJson(value: unknown): string {
	const serialized = JSON.stringify(stableJsonClone(value));
	if (serialized === undefined) throw new TypeError("Value is not JSON-serializable");
	return serialized;
}

/**
 * `Bun.deepEquals(a, b)` (not strict) for JSON-shaped data of any depth: it
 * walks arrays and plain or null-prototype objects on its own stack
 * ({@link runNested}), where `Bun.deepEquals` recurses and runs out of stack
 * near 16,000 levels, while a value parsed from a transcript line nests
 * millions. It keeps `Bun.deepEquals`' rules: an array equals an array whose
 * element at each index (a hole and a missing trailing element read as
 * `undefined`) is equal, other keys of an array ignored; an object equals an
 * object with the same own enumerable string and symbol keys holding equal
 * values, in any order, a key holding `undefined` read as absent and a
 * prototype ignored; an array never equals an object. Every other pair (two
 * primitives, compared as `Object.is` compares them; a `Date`, `Map`, boxed
 * primitive or class instance) is compared by `Bun.deepEquals` itself. A pair
 * of containers met again inside itself, a cycle through arrays and plain
 * objects (a tool's `details` can hold one, though JSON cannot), is answered
 * as `Bun.deepEquals` answers it ({@link ContainerPairPath}): equal where both
 * values cycle back to the same pair, unequal where their cycles differ in
 * shape. A cycle through a `Map`, `Set`, `Date` or class instance goes to a new
 * `Bun.deepEquals` call, which can answer true where `Bun.deepEquals` of the
 * whole value answers false.
 */
export function jsonDeepEquals(a: unknown, b: unknown): boolean {
	return isWalkedContainer(a) && isWalkedContainer(b)
		? runNested(equalContainers(a, b, new ContainerPairPath()))
		: Bun.deepEquals(a, b);
}

/** Whether {@link jsonDeepEquals} walks `value` itself: an array, or an object whose prototype is `Object.prototype` or `null`. */
function isWalkedContainer(value: unknown): value is object {
	return isNonNullObject(value) && (Array.isArray(value) || isJsonRecord(value));
}

/** `value`'s own enumerable keys, strings in `Object.keys` order and then symbols. */
function ownEnumerableKeys(value: object): Array<string | symbol> {
	const keys: Array<string | symbol> = Object.keys(value);
	for (const symbol of Object.getOwnPropertySymbols(value)) {
		if (Object.prototype.propertyIsEnumerable.call(value, symbol)) keys.push(symbol);
	}
	return keys;
}

/** {@link jsonDeepEquals} of two containers it walks, a pair `path` is inside of; each pair of child containers is a nested step. */
function* equalContainers(a: object, b: object, path: ContainerPairPath): NestedWalk<boolean> {
	if (a === b) return true;
	const isArray = Array.isArray(a);
	if (isArray !== Array.isArray(b)) return false;
	const metAgain = path.enter(a, b);
	if (metAgain !== undefined) return metAgain;
	if (isArray) {
		const left = a as readonly unknown[];
		const right = b as readonly unknown[];
		const length = Math.max(left.length, right.length);
		for (let index = 0; index < length; index++) {
			const x = left[index];
			const y = right[index];
			const equal =
				isWalkedContainer(x) && isWalkedContainer(y) ? yield equalContainers(x, y, path) : Bun.deepEquals(x, y);
			if (!equal) return false;
		}
	} else {
		let defined = 0;
		for (const key of ownEnumerableKeys(a)) {
			const x: unknown = Reflect.get(a, key);
			if (x === undefined) continue;
			defined++;
			if (!Object.prototype.propertyIsEnumerable.call(b, key)) return false;
			const y: unknown = Reflect.get(b, key);
			const equal =
				isWalkedContainer(x) && isWalkedContainer(y) ? yield equalContainers(x, y, path) : Bun.deepEquals(x, y);
			if (!equal) return false;
		}
		for (const key of ownEnumerableKeys(b)) if (Reflect.get(b, key) !== undefined) defined--;
		if (defined !== 0) return false;
	}
	path.leave(a, b);
	return true;
}
