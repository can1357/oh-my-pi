/**
 * Chromium's canonical preference serialization (`base::WriteJson` + the empty-value pruning in
 * `services/preferences/tracked/pref_hash_calculator.cc`). Authenticators are HMACs over exactly these bytes, so a
 * difference of one escape character makes Chrome treat a written preference as tampered.
 */
import { isRecord } from "@oh-my-pi/pi-utils";

/** JSON value accepted by {@link chromiumJson}. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Removes empty dictionaries and lists bottom-up, as Chrome does before hashing. */
function prune(value: JsonValue): JsonValue {
	if (Array.isArray(value)) {
		const items: JsonValue[] = [];
		for (const item of value) {
			const pruned = prune(item);
			if (Array.isArray(pruned) && pruned.length === 0) continue;
			if (isRecord(pruned) && isEmptyRecord(pruned)) continue;
			items.push(pruned);
		}
		return items;
	}
	if (isRecord(value)) {
		const entries: Record<string, JsonValue> = {};
		for (const key in value) {
			const pruned = prune(value[key] as JsonValue);
			if (Array.isArray(pruned) && pruned.length === 0) continue;
			if (isRecord(pruned) && isEmptyRecord(pruned)) continue;
			entries[key] = pruned;
		}
		return entries;
	}
	return value;
}

function isEmptyRecord(value: Record<string, unknown>): boolean {
	for (const _ in value) return false;
	return true;
}

/**
 * Escapes a string like `base::EscapeJSONString`: control characters, quote, backslash, `<` (HTML safety), and the
 * Unicode line separators. `>` and `&` stay literal — Chromium only escapes `<`.
 */
function escapeString(value: string): string {
	const parts: string[] = ['"'];
	for (const char of value) {
		const code = char.codePointAt(0)!;
		switch (char) {
			case '"':
				parts.push('\\"');
				continue;
			case "\\":
				parts.push("\\\\");
				continue;
			case "\b":
				parts.push("\\b");
				continue;
			case "\f":
				parts.push("\\f");
				continue;
			case "\n":
				parts.push("\\n");
				continue;
			case "\r":
				parts.push("\\r");
				continue;
			case "\t":
				parts.push("\\t");
				continue;
			case "<":
				parts.push("\\u003C");
				continue;
		}
		if (code === 0x2028) parts.push("\\u2028");
		else if (code === 0x2029) parts.push("\\u2029");
		else if (code < 0x20) parts.push(`\\u${code.toString(16).toUpperCase().padStart(4, "0")}`);
		else parts.push(char);
	}
	parts.push('"');
	return parts.join("");
}

function write(value: JsonValue): string {
	if (value === null) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return String(value);
	if (typeof value === "string") return escapeString(value);
	if (Array.isArray(value)) {
		const items: string[] = [];
		for (const item of value) items.push(write(item));
		return `[${items.join(",")}]`;
	}
	const fields: string[] = [];
	for (const key in value) fields.push(`${escapeString(key)}:${write(value[key] as JsonValue)}`);
	return `{${fields.join(",")}}`;
}

/**
 * Serializes `value` to the bytes Chromium hashes for a tracked preference. The value is pruned and written compactly
 * (no whitespace) with Chromium's escapes.
 */
export function chromiumJson(value: JsonValue): string {
	return write(prune(value));
}
