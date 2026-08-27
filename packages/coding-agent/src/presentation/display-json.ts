import type { JsonValue, ToolDisplayItem } from "@oh-my-pi/pi-agent-core/presentation";
import { setOwnJsonProperty } from "@oh-my-pi/pi-agent-core/presentation";

const MAX_JSON_DEPTH = 128;
/**
 * Cap on total visited values. Aliases re-visit (the `seen` set is scoped to
 * the current recursion path so DAGs stay representable), which means depth
 * alone cannot bound total work: a ~40-level chain aliasing one shared child
 * at two properties stays within the depth cap while expanding 2^depth
 * duplicate subtrees — and this normalization runs synchronously BEFORE the
 * live-record display byte budget can bound anything. Mirrors agent-loop's
 * `normalizeJsonValue` node budget.
 */
const MAX_JSON_NODES = 100_000;

type NormalizeResult = { readonly ok: true; readonly value: JsonValue } | { readonly ok: false };

const INVALID: NormalizeResult = { ok: false };

function valid(value: JsonValue): NormalizeResult {
	return { ok: true, value };
}

/**
 * Clone an untrusted eval display value into a canonical JSON tree.
 *
 * Backend values can originate in a kernel, extension, or bridge. Inspecting
 * descriptors rather than reading properties avoids executing accessors; a
 * reflection trap or malformed descriptor becomes the stable typed fallback.
 */
export function normalizeDisplayJson(value: unknown): ToolDisplayItem {
	try {
		const state: NormalizeState = { seen: new WeakSet<object>(), nodes: 0 };
		const result = normalizeValue(value, state, 0);
		return result.ok ? { kind: "json", value: result.value } : { kind: "invalid_json" };
	} catch {
		return { kind: "invalid_json" };
	}
}

/** Per-normalization walk state: the recursion-path `seen` set plus the total-node counter. */
interface NormalizeState {
	readonly seen: WeakSet<object>;
	nodes: number;
}

function normalizeValue(value: unknown, state: NormalizeState, depth: number): NormalizeResult {
	if (++state.nodes > MAX_JSON_NODES) return INVALID;
	if (depth > MAX_JSON_DEPTH) return INVALID;
	if (value === null) return valid(null);
	switch (typeof value) {
		case "string":
		case "boolean":
			return valid(value);
		case "number":
			return Number.isFinite(value) ? valid(value) : INVALID;
		case "object":
			break;
		default:
			return INVALID;
	}

	if (state.seen.has(value)) return INVALID;
	state.seen.add(value);
	try {
		return Array.isArray(value) ? normalizeArray(value, state, depth) : normalizeObject(value, state, depth);
	} finally {
		state.seen.delete(value);
	}
}

function normalizeArray(value: unknown[], state: NormalizeState, depth: number): NormalizeResult {
	const descriptors = Object.getOwnPropertyDescriptors(value);
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string" || (key !== "length" && !isArrayIndex(key))) return INVALID;
	}
	const normalized: JsonValue[] = [];
	for (let index = 0; index < value.length; index++) {
		const descriptor = descriptors[String(index)];
		if (descriptor === undefined || !("value" in descriptor)) return INVALID;
		const item = normalizeValue(descriptor.value, state, depth + 1);
		if (!item.ok) return INVALID;
		normalized.push(item.value);
	}
	return valid(normalized);
}

function normalizeObject(value: object, state: NormalizeState, depth: number): NormalizeResult {
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return INVALID;
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const keys = Reflect.ownKeys(value);
	const normalized: { [key: string]: JsonValue } = {};
	for (const key of keys) {
		if (typeof key !== "string") return INVALID;
		const descriptor = descriptors[key];
		if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return INVALID;
		const item = normalizeValue(descriptor.value, state, depth + 1);
		if (!item.ok) return INVALID;
		setOwnJsonProperty(normalized, key, item.value);
	}
	return valid(normalized);
}

function isArrayIndex(key: string): boolean {
	if (key.length === 0 || key === "0") return key === "0";
	if (key[0] === "0") return false;
	const index = Number(key);
	return Number.isSafeInteger(index) && index >= 0 && index < 2 ** 32 - 1 && String(index) === key;
}
