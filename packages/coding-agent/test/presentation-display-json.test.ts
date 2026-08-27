import { describe, expect, it } from "bun:test";
import { normalizeDisplayJson } from "../src/presentation/display-json";

describe("normalizeDisplayJson __proto__ handling", () => {
	it("preserves an own __proto__ key from valid JSON without polluting the output's prototype", () => {
		// `JSON.parse` creates `__proto__` as an ordinary own data property; a
		// naive `normalized[key] = value` re-assembly would instead invoke the
		// legacy prototype setter — silently dropping the key from displayed,
		// persisted, and replayed JSON and mutating the output's prototype.
		const input = JSON.parse('{"__proto__":{"secret":"x"},"ok":1}');
		const item = normalizeDisplayJson(input);
		if (item.kind !== "json") throw new Error("expected a json display item");
		const value = item.value as { [key: string]: unknown };

		expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
		expect(Object.getOwnPropertyNames(value).sort()).toEqual(["__proto__", "ok"]);
		expect(JSON.stringify(value)).toBe('{"__proto__":{"secret":"x"},"ok":1}');
	});
});
