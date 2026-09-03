import { describe, expect, it } from "bun:test";
import { type Type, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

type Constructor = abstract new (...args: never[]) => unknown;

describe("type.cast", () => {
	it("primitive", () => {
		const Foo = type("string" as type.cast<"foo">).t;
		const _foo: Eq<typeof Foo, "foo"> = true;
	});

	it("object", () => {
		const value = type({ a: "string" } as type.cast<{ a: "foo" }>).t;
		const _object: Eq<typeof value, { a: "foo" }> = true;
	});

	it("primitive to object", () => {
		const value = type("string" as type.cast<{ a: "foo" }>).t;
		const _primitiveToObject: Eq<typeof value, { a: "foo" }> = true;
	});

	it("object to primitive", () => {
		const value = type({ a: "string" } as type.cast<"foo">).t;
		const _objectToPrimitive: Eq<typeof value, "foo"> = true;
	});

	it("infer function", () => {
		type F = () => boolean;
		const Constructable = type({} as type.cast<F>);
		const _t: Eq<typeof Constructable.t, F> = true;
		const _infer: Eq<typeof Constructable.infer, F> = true;
		const _inferIn: Eq<typeof Constructable.in.infer, F> = true;
	});

	it("infer constructable", () => {
		const Constructable = type({} as type.cast<Constructor>);
		const _t: Eq<typeof Constructable.t, Constructor> = true;
		const _infer: Eq<typeof Constructable.infer, Constructor> = true;
		const _inferIn: Eq<typeof Constructable.in.infer, Constructor> = true;
	});

	it("undefined", () => {
		const Foo = type("string" as type.cast<"foo">).t;
		const _foo: Eq<typeof Foo, "foo"> = true;
	});
});

describe("as", () => {
	it("valid cast", () => {
		const From = type("/^foo.*$/");
		const T = From.as<`foo${string}`>();
		const _t: Eq<typeof T.t, `foo${string}`> = true;
		expect(T === From).toBe(true);
	});

	it("cast to any", () => {
		const T = type("unknown").as<any>();
		const _t: Eq<typeof T.t, any> = true;
	});

	it("cast to never", () => {
		const T = type("unknown").as<never>();
		const _t: Eq<typeof T.t, never> = true;
	});

	it("missing type param", () => {
		type("string").as();
	});

	it("runtime arguments do not alter the cast", () => {
		const T = type("string");
		expect(T.as("foo" as never)).toBe(T);
	});
});

describe("readonly ", () => {
	it("object", () => {
		const From = type({ foo: "string", bar: "number" });
		const T = From.readonly();
		const _t: Eq<typeof T, Type<{ readonly foo: string; readonly bar: number }>> = true;
		expect(T === From).toBe(true);
	});

	it("array", () => {
		const From = type("string").array();
		const T = From.readonly();
		const _t: Eq<typeof T, Type<readonly string[]>> = true;
		expect(T === From).toBe(true);
	});
});
