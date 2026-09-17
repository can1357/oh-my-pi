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

	it("invokes stateful serializers once, like the plain replacer", () => {
		let calls = 0;
		const value = { a: 1n, b: { toJSON: () => ++calls } };
		expect(stringifyJson(value)).toBe('{"a":"1","b":1}');
		expect(calls).toBe(1);
	});

	it("still throws the original TypeError for non-serializable values", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(() => stringifyJson(circular)).toThrow(TypeError);
	});

	it("rethrows user-code TypeErrors instead of coercing past them", () => {
		let calls = 0;
		const flaky = {
			toJSON: () => {
				if (++calls < 3) throw new TypeError(`boom-${calls}`);
				return 1;
			},
		};
		expect(() => stringifyJson({ x: flaky })).toThrow("boom-2");
		expect(calls).toBe(2);
	});
});
