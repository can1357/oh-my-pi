/**
 * A canonical JSON tree. This lives in the presentation leaf because both
 * presentation payloads and hook-owned arguments cross untyped boundaries.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Assign `value` as an OWN enumerable data property of `record`.
 *
 * A plain `record[key] = value` with key `"__proto__"` invokes the legacy
 * prototype setter instead of creating an own property: the key silently
 * vanishes from the output and the record's prototype is mutated. JSON allows
 * `"__proto__"` as an ordinary key (`JSON.parse` creates it as an own data
 * property), so every normalizer assembling a record from untrusted JSON keys
 * MUST assign through this helper — the shared boundary for
 * `normalizeJsonValue` (agent-loop's hook-revised arguments) and
 * `normalizeDisplayJson` (coding-agent's eval display values).
 */
export function setOwnJsonProperty(record: { [key: string]: JsonValue }, key: string, value: JsonValue): void {
	if (key === "__proto__") {
		Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
		return;
	}
	record[key] = value;
}
