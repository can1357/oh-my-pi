import { stringifyDeepJson } from "./json";
import { ContainerPath, isStackOverflow, type NestedWalk, runNested } from "./nested-walk";
import { isJsonRecord } from "./type-guards";

export { once, untilAborted } from "./abortable";
export * from "./async";
export * from "./binary";
export * from "./bounded-json";
export * from "./bytes";
export * from "./color";
export * from "./dirs";
export * from "./env";
export * from "./executable";
export * from "./fetch-retry";
export * from "./file-lock";
export * from "./format";
export * from "./frontmatter";
export * from "./fs-error";
export * from "./incoming-json";
export * from "./json";
export * from "./json-parse";
export * from "./laps";
export * as logger from "./logger";
export * from "./loop-phase";
export * from "./math-delimiters";
export * from "./materialize-string";
export * from "./mermaid-ascii";
export * from "./mime";
export * from "./nested-walk";
export * from "./path";
export * from "./path-tree";
export * from "./peek-file";
export * from "./pid";
export * as postmortem from "./postmortem";
export * from "./process-name";
export * as procmgr from "./procmgr";
export * as prompt from "./prompt";
export * as ptree from "./ptree";
export { AbortError, ChildProcess, Exception, NonZeroExitError } from "./ptree";
export * from "./runtime-install";
export * from "./sanitize-text";
export * from "./slugify";
export * from "./snowflake";
export * from "./spill-url";
export * from "./sqlite";
export * from "./stderr-guard";
export * from "./stream";
export * from "./tab-spacing";
export * from "./temp";
export * from "./tls-fetch";
export * from "./type-guards";
export * from "./version";
export * from "./which";
export * from "./yaml-config";

function isPlainObject(val: object): val is Record<string, unknown> {
	return Object.getPrototypeOf(val) === Object.prototype || Array.isArray(val);
}

/**
 * A copy of `value`: an array or an object whose prototype is `Object.prototype`
 * as {@link structuredCloneDeep} copies it, so a `Map` or `Date` inside stays
 * one; any other object, or one that `structuredClone` cannot copy (it holds a
 * function), as `JSON.parse` reads the JSON {@link stringifyDeepJson} writes of
 * it. Both copy a value of any depth `JSON.parse` reads.
 */
export function structuredCloneJSON<T>(value: T): T {
	// primitives|null|undefined, copy
	if (!value || typeof value !== "object") {
		return value;
	}

	// deep clone
	if (isPlainObject(value)) {
		try {
			return structuredCloneDeep(value);
		} catch {
			// A function or symbol inside, which the JSON copy leaves out.
		}
	}
	return JSON.parse(stringifyDeepJson(value) as string) as T;
}

/**
 * Deep-copies a JSON-shaped tree (arrays and plain or null-prototype objects)
 * so later mutation of the source can never reach the copy. Strings and other
 * primitives are immutable and shared, so the cost is O(containers) instead of
 * `structuredClone`'s O(bytes) — the difference matters for hot paths that
 * re-copy large string payloads (e.g. streamed tool-call arguments) per delta.
 *
 * Copies own enumerable string keys only. Any other object (class instance,
 * Date, Map, inherited-prototype object) is copied with {@link structuredCloneJSON}.
 * An array's length is read once, as `Array.prototype.map` reads it, and a
 * hole stays a hole. The copy keeps its own stack ({@link runNested}), so it
 * copies a tree of any depth `JSON.parse` reads (a session entry read from a
 * transcript line, say), where a recursive copy stops near 22,500 levels; a
 * cycle, which JSON data never holds, throws the `TypeError` `JSON.stringify`
 * throws.
 */
export function cloneJsonTree<T>(value: T): T {
	if (value === null || typeof value !== "object") return value;
	return runNested(cloneJsonNode(value, new ContainerPath())) as T;
}

/**
 * `structuredClone(value)`, also for a value nested deeper than its recursion
 * allows: Bun's `structuredClone` throws `Maximum call stack size exceeded`
 * near 40,000 levels, and sooner on a deep call stack or a worker thread.
 * Every value `structuredClone` copies is copied by it. On that stack overflow
 * ({@link isStackOverflow}) the value is copied again on a stack of the copy's
 * own ({@link structuredCloneIteratively}), which copies its arrays and plain
 * objects itself: among them a shared object stays shared and a cycle stays a
 * cycle, and a function throws its `DataCloneError`. It hands every other
 * object (a `Map`, `Set`, `Date`, typed array or class instance) to a
 * `structuredClone` call of its own, which keeps its type, with two limits:
 * - Each of those calls copies apart from the rest: an object both inside one
 *   (a `Map` key or value, a `Set` member, a class instance's field) and
 *   elsewhere in the value becomes two copies, and two typed arrays over one
 *   buffer get a buffer each.
 * - A branch inside one nested past that call's reach, or a cycle through one
 *   back into the deep part, still throws `Maximum call stack size exceeded`.
 *
 * Only data parsed from JSON nests that deep (a tool call's arguments, a
 * session entry read from a transcript line), and it holds none of those
 * objects. The getters ahead of the overflow run twice on that path. Any other
 * error is its own, a `RangeError` a getter throws included. That failed
 * attempt costs tens of milliseconds, and a shallow value pays no depth check.
 */
export function structuredCloneDeep<T>(value: T): T {
	try {
		return structuredClone(value);
	} catch (error) {
		if (!isStackOverflow(error)) throw error;
		return structuredCloneIteratively(value) as T;
	}
}

/** An array or record {@link structuredCloneIteratively} made, and the source it copies the keys of into it. */
type UnfilledCopy = readonly [source: object, copy: Record<string, unknown>];

/**
 * `structuredClone(value)` without recursion. It copies each array, and each
 * object whose prototype is `Object.prototype` or `null`, itself, as
 * `structuredClone` copies them: an array keeps its length, its holes and its
 * other own enumerable keys, an object becomes a plain object with its own
 * enumerable string keys, and each value is read once (a getter's included).
 * Any other value is copied by `structuredClone` itself, so a `Map`, `Set`,
 * `Date`, `RegExp`, typed array or `ArrayBuffer` keeps its type, a class
 * instance becomes a plain object, and a function or symbol throws its
 * `DataCloneError`. An object met twice is copied once, so a shared object
 * stays shared and a cycle stays a cycle. Each of those `structuredClone`
 * calls copies apart from the rest: an object both inside one and elsewhere
 * (a buffer two typed arrays view, say) is copied twice, and a value nested
 * past its reach inside one still overflows.
 */
function structuredCloneIteratively(root: unknown): unknown {
	const copies = new Map<object, unknown>();
	const unfilled: UnfilledCopy[] = [];
	const copyOf = (value: unknown): unknown => {
		if (typeof value !== "object" || value === null) {
			return typeof value === "function" || typeof value === "symbol" ? structuredClone(value) : value;
		}
		if (copies.has(value)) return copies.get(value);
		let copy: unknown;
		if (Array.isArray(value)) {
			const array: unknown[] = [];
			array.length = value.length;
			unfilled.push([value, array as unknown as Record<string, unknown>]);
			copy = array;
		} else if (isJsonRecord(value)) {
			const record: Record<string, unknown> = {};
			unfilled.push([value, record]);
			copy = record;
		} else {
			copy = structuredClone(value);
		}
		copies.set(value, copy);
		return copy;
	};
	const copy = copyOf(root);
	for (let next = unfilled.pop(); next !== undefined; next = unfilled.pop()) {
		const [source, target] = next;
		for (const key of Object.keys(source)) {
			const item = copyOf((source as Record<string, unknown>)[key]);
			// Assigning `__proto__` would swap the copy's prototype instead of creating the own key.
			if (key === "__proto__") {
				Object.defineProperty(target, key, { value: item, enumerable: true, writable: true, configurable: true });
			} else {
				target[key] = item;
			}
		}
	}
	return copy;
}

/** {@link cloneJsonTree} of `value`, an object `path` is inside of; each child object is a nested step. */
function* cloneJsonNode(value: object, path: ContainerPath): NestedWalk {
	if (Array.isArray(value)) {
		path.enter(value);
		const out: unknown[] = [];
		for (let index = 0, length = value.length; index < length; index++) {
			// A hole stays a hole, as `Array.prototype.map` leaves it.
			if (!(index in value)) {
				out.length = index + 1;
				continue;
			}
			const item: unknown = value[index];
			out.push(item !== null && typeof item === "object" ? yield cloneJsonNode(item, path) : item);
		}
		path.leave(value);
		return out;
	}
	if (!isJsonRecord(value)) return structuredCloneJSON(value);
	path.enter(value);
	const out: Record<string, unknown> = {};
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		const item = value[key];
		const child = item !== null && typeof item === "object" ? yield cloneJsonNode(item, path) : item;
		// Assigning `__proto__` would swap the copy's prototype instead of
		// creating the own data property JSON.parse produces.
		if (key === "__proto__") {
			Object.defineProperty(out, key, { value: child, enumerable: true, writable: true, configurable: true });
		} else {
			out[key] = child;
		}
	}
	path.leave(value);
	return out;
}
