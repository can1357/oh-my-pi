import { describe, expect, it } from "bun:test";
import { stableStringifyJson } from "@oh-my-pi/pi-utils/json";

describe("stableStringifyJson", () => {
	it("canonicalizes nested object key order while preserving array order", () => {
		const left = { settings: { beta: 2, alpha: { z: true, a: false } }, args: ["--b", "--a"] };
		const right = { args: ["--b", "--a"], settings: { alpha: { a: false, z: true }, beta: 2 } };

		expect(stableStringifyJson(left)).toBe(stableStringifyJson(right));
		expect(stableStringifyJson({ args: ["--a", "--b"] })).not.toBe(stableStringifyJson({ args: ["--b", "--a"] }));
	});

	it("preserves __proto__ as an ordinary own JSON key", () => {
		const value: unknown = JSON.parse('{"__proto__":{"x":1}}');

		expect(stableStringifyJson(value)).toBe('{"__proto__":{"x":1}}');
		expect(stableStringifyJson(value)).not.toBe(stableStringifyJson({}));
	});

	it("rejects a top-level value JSON cannot serialize", () => {
		expect(() => stableStringifyJson(undefined)).toThrow("Value is not JSON-serializable");
	});
});
