import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

describe("tuple expression", () => {
	it("literal", () => {
		const T = type(["===", 5]);
		const _infer: Eq<typeof T.infer, 5> = true;
		expect(_infer).toBe(true);
	});

	it("symbol with description", () => {
		const ism = Symbol("ism");
		const T = type(["===", ism]);
		expect(T(ism)).toBe(ism);

		const ick = Symbol("ick");
		expect(String(T(ick))).toBe("must be Symbol(ism) (was a symbol)");
	});

	it("anonymous symbol", () => {
		const anon = Symbol();
		const anonName = String(anon);
		const T = type(["===", anon]);
		const _infer: Eq<typeof T.infer, typeof anon> = true;
		expect(_infer).toBe(true);
		expect(T(anon)).toBe(anon);
		expect(String(T("test"))).toBe(`must be ${anonName} (was "test")`);
	});

	it("branches", () => {
		const o = { ark: true };
		const s = Symbol();
		const T = type(["===", true, "foo", 5, 1n, null, undefined, o, s]);
		const _infer: Eq<typeof T.infer, true | "foo" | 5 | 1n | null | undefined | { ark: boolean } | typeof s> = true;
		expect(_infer).toBe(true);
	});
});

describe("root expression", () => {
	it("single", () => {
		const T = type("===", true);
		const _infer: Eq<typeof T.infer, true> = true;
		expect(_infer).toBe(true);
	});

	it("branches", () => {
		const o = { ark: true };
		const s = Symbol();
		const T = type("===", "foo", 5, true, null, 1n, undefined, o, s);
		const _infer: Eq<typeof T.infer, true | "foo" | 5 | 1n | null | undefined | { ark: boolean } | typeof s> = true;
		expect(_infer).toBe(true);
	});
});
