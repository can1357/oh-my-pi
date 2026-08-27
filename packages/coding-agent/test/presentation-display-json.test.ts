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

describe("normalizeDisplayJson node budget", () => {
	it("rejects a shallow DAG whose aliasing expands past the node budget instead of hanging", () => {
		// A 40-level chain where every level aliases the SAME child at two
		// properties: well within the 128 depth cap, but expanding every alias
		// into an independent subtree walks 2^40 paths. structuredClone (the
		// eval bridge) preserves such aliases, and this normalization runs
		// synchronously BEFORE the live-record display byte budget — the node
		// budget must reject it deterministically instead of hanging the CLI.
		let shared: Record<string, unknown> = { leaf: true };
		for (let level = 0; level < 40; level++) {
			shared = { a: shared, b: shared };
		}
		expect(normalizeDisplayJson(shared)).toEqual({ kind: "invalid_json" });
	});

	it("still normalizes an ordinary aliased value (DAG, not a cycle) within the budget", () => {
		const child = { n: 1 };
		const item = normalizeDisplayJson({ first: child, second: child });
		if (item.kind !== "json") throw new Error("expected a json display item");
		expect(item.value).toEqual({ first: { n: 1 }, second: { n: 1 } });
	});
});
