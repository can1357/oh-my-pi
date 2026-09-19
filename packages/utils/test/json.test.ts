import { describe, expect, it } from "bun:test";
import { stableStringifyJson, stringifyJson } from "@oh-my-pi/pi-utils/json";

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

describe("stringifyJson", () => {
	it("serializes bigint values as decimal strings", () => {
		expect(stringifyJson({ n: 10n })).toBe('{"n":"10"}');
	});

	it("serializes bigints produced by toJSON", () => {
		expect(stringifyJson({ o: { toJSON: () => 5n } })).toBe('{"o":"5"}');
	});

	it("coerces bigints that follow a stateful serializer", () => {
		let calls = 0;
		const value = { a: { toJSON: () => ++calls }, b: 1n };
		expect(stringifyJson(value)).toBe('{"a":2,"b":"1"}');
	});

	it("still throws TypeError for non-serializable values", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(() => stringifyJson(circular)).toThrow(TypeError);
	});

	it("rethrows non-TypeError serializer failures without retrying", () => {
		let calls = 0;
		const failing = {
			toJSON: () => {
				calls++;
				throw new RangeError("boom");
			},
		};
		expect(() => stringifyJson({ x: failing })).toThrow(RangeError);
		expect(calls).toBe(1);
	});
});
