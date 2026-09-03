import { describe, expect, it } from "bun:test";
import { scope, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

describe("identifier", () => {
	it("keyword", () => {
		const T = type("string");
		const _infer: Eq<typeof T.infer, string> = true;
		expect(_infer).toBe(true);
	});

	it("alias", () => {
		const a = scope({ a: "string" }).type("a");
		const _infer: Eq<typeof a.infer, string> = true;
		expect(_infer).toBe(true);
	});

	it("unresolvable", () => {
		expect(() => type("HUH")).toThrow();
	});
});

describe("number", () => {
	it("positive whole", () => {
		const Four = type("4");
		const _infer: Eq<typeof Four.infer, 4> = true;
		expect(_infer).toBe(true);
	});

	it("positive decimal", () => {
		const T = type("3.14159");
		const _infer: Eq<typeof T.infer, 3.14159> = true;
		expect(_infer).toBe(true);
	});

	it("positive decimal with zero whole portion", () => {
		const T = type("0.5");
		const _infer: Eq<typeof T.infer, 0.5> = true;
		expect(_infer).toBe(true);
	});

	it("negative whole", () => {
		const T = type("-12");
		const _infer: Eq<typeof T.infer, -12> = true;
		expect(_infer).toBe(true);
	});

	it("negative decimal", () => {
		const T = type("-1.618");
		const _infer: Eq<typeof T.infer, -1.618> = true;
		expect(_infer).toBe(true);
	});

	it("negative decimal with zero whole portion", () => {
		const T = type("-0.001");
		const _infer: Eq<typeof T.infer, -0.001> = true;
		expect(_infer).toBe(true);
	});

	it("zero", () => {
		const T = type("0");
		const _infer: Eq<typeof T.infer, 0> = true;
		expect(_infer).toBe(true);
	});

	it("multiple decimals", () => {
		expect(() => type("127.0.0.1")).toThrow();
	});

	it("with alpha", () => {
		expect(() => type("13three7")).toThrow();
	});

	it("leading zeroes", () => {
		expect(() => type("010")).toThrow("Malformed number literal '010'");
	});

	it("trailing zeroes", () => {
		expect(() => type("4.0")).toThrow("Malformed number literal '4.0'");
	});

	it("negative zero", () => {
		expect(() => type("-0")).toThrow("Malformed number literal '-0'");
	});
});

describe("bigint", () => {
	it("positive", () => {
		const T = type("12345678910987654321n");
		const _infer: Eq<typeof T.infer, 12345678910987654321n> = true;
		expect(_infer).toBe(true);
	});

	it("negative", () => {
		const T = type("-9801n");
		const _infer: Eq<typeof T.infer, -9801n> = true;
		expect(_infer).toBe(true);
	});

	it("zero", () => {
		const T = type("0n");
		const _infer: Eq<typeof T.infer, 0n> = true;
		expect(_infer).toBe(true);
	});

	it("decimal", () => {
		expect(() => type("999.1n")).toThrow();
	});

	it("leading zeroes", () => {
		expect(() => type("007n")).toThrow("Malformed number literal '007n'");
	});

	it("negative zero", () => {
		expect(() => type("-0n")).toThrow("Malformed number literal '-0n'");
	});
});
