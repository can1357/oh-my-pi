import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

describe("tuple expression", () => {
	it("base", () => {
		const T = type(["instanceof", Error]);
		const _1: Eq<typeof T.infer, Error> = true;
		const Expected = type.instanceOf(Error);
		expect(T.json).toEqual(Expected.json);
		const e = new Error();
		expect(T(e)).toEqual(e);
		expect(T(e)).toEqual(e);
		expect(T({}).toString()).toEqual("must be an Error (was an object)");
		expect(T(undefined).toString()).toEqual("must be an Error (was undefined)");
	});

	it("fluent", () => {
		const T = type.instanceOf(Error);

		const Expected = type(["instanceof", Error]);

		const _2: Eq<typeof T.t, typeof Expected.t> = true;
		expect(T.expression).toEqual(Expected.expression);
	});

	it("inherited", () => {
		const T = type(["instanceof", TypeError]);
		const e = new TypeError();
		// for some reason the return of TypeError's constructor is actually
		// inferred as Error? Disabling this check for now, seems like an anomaly.
		// expect<TypeError>(T.infer)
		expect(T(e)).toEqual(e);
		expect(T(new Error()).toString()).toEqual("must be an instance of TypeError (was Error)");
	});
	it("abstract", () => {
		abstract class Base {
			abstract foo: string;
		}
		class Sub extends Base {
			foo = "";
		}
		const T = type(["instanceof", Base]);
		const _3: Eq<typeof T.infer, Base> = true;
		const sub = new Sub();
		expect(T(sub)).toEqual(sub);
	});
	it("multiple branches", () => {
		const T = type(["instanceof", Date, Array]);
		const _4: Eq<typeof T.infer, Date | unknown[]> = true;
	});
	it("non-constructor", () => {
		// @ts-expect-error exercises runtime validation for untyped JavaScript callers
		expect(() => type(["instanceof", () => {}])).toThrow("instanceof operands must be constructors");
	});

	// If perf cost too high can use global type config to expand ArkEnv.preserve
	it("user-defined class", () => {
		class ArkClass {
			isArk = true;
		}
		const Ark = type(["instanceof", ArkClass]);
		const _5: Eq<typeof Ark.t, ArkClass> = true;
		// not expanded since there are no morphs
		const _6: Eq<typeof Ark.infer, ArkClass> = true;
		const _7: Eq<typeof Ark.in.infer, ArkClass> = true;
		const a = new ArkClass();
		expect(Ark(a)).toEqual(a);
		expect(Ark({}).toString()).toEqual("must be an instance of ArkClass (was an object)");
	});
	it("bidirectional checks doesn't break pipe inference", () => {
		const T = type({
			f: ["string", "=>", () => [] as unknown],
		});
		// Should be inferred as {f: unknown}
		const _8: Eq<typeof T.infer, { f: unknown }> = true;
	});

	it("class with private properties", () => {
		class ArkClass {}
		const Ark = type(["instanceof", ArkClass]);

		const _9: Eq<typeof Ark.t, ArkClass> = true;
		// not expanded since there are no morphs
		const _10: Eq<typeof Ark.infer, ArkClass> = true;
		const _11: Eq<typeof Ark.in.infer, ArkClass> = true;
	});

	it("parse error on non-function", () => {
		// @ts-expect-error exercises runtime validation for untyped JavaScript callers
		expect(() => type.instanceOf({})).toThrow();
	});
});

describe("root expression", () => {
	it("class", () => {
		const T = type("instanceof", Error);
		const _12: Eq<typeof T.infer, Error> = true;
		expect(T.json).toEqual(type(["instanceof", Error]).json);
	});
	it("instance branches", () => {
		const T = type("instanceof", Date, Map);
		const _13: Eq<typeof T.infer, Date | Map<unknown, unknown>> = true;
		expect(T.json).toEqual(type("Date | Map").json);
	});
	it("non-constructor", () => {
		// @ts-expect-error exercises runtime validation for untyped JavaScript callers
		expect(() => type("instanceof", new Error())).toThrow("instanceof operands must be constructors");
	});
});
