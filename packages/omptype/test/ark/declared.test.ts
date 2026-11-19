import { expect, it } from "bun:test";
import { declare, type Out, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

it("shallow", () => {
	const shallow = declare<number>().type("number");
	const _assert1: Eq<typeof shallow.infer, number> = true;
	expect(shallow.json).toEqual(type("number").json);
});

it("obj", () => {
	type Expected = { a: string; b?: number };
	const T = declare<Expected>().type({
		a: "string",
		"b?": "number",
	});
	const _assert2: Eq<typeof T.infer, Expected> = true;
	// name should be preserved
	void T.t;
});

it("syntax error", () => {
	type Expected = { a: string; b?: number };
	expect(() =>
		declare<Expected>().type({
			a: "string[",
		}),
	).toThrow();
});

it("tuple", () => {
	type Expected = [string, number];
	const T = declare<Expected>().type(["string", "number"]);
	const _assert3: Eq<typeof T.infer, Expected> = true;
});

it("tuple expression", () => {
	const T = declare<0 | 1>().type(["0", "|", "1"]);
	const _assert4: Eq<typeof T.infer, 0 | 1> = true;
});

it("regexp", () => {
	const T = declare<string>().type(/.*/);
	const _assert5: Eq<typeof T.t, string> = true;
	const _assert6: Eq<typeof T.infer, string> = true;
});

it("Inferred<t>", () => {
	const Foo = type("'foo'");
	const T = declare<"foo">().type(Foo);
	const _assert7: Eq<typeof T.infer, "foo"> = true;
});

it("undefined as required value", () => {
	type Expected = { f: string | undefined };

	const T = declare<Expected>().type({ f: "string | undefined" });

	const _assert8: Eq<typeof T.t, Expected> = true;
});

it("undefined as optional value", () => {
	type Expected = { f?: string | undefined };

	const T = declare<Expected>().type({ "f?": "string | undefined" });

	const _assert9: Eq<typeof T.t, Expected> = true;
});

it("morph in", () => {
	type Expected = { a: string; b?: number };
	const T = declare<Expected, { side: "in" }>().type({
		a: "string.numeric.parse",
		"b?": "number",
	});

	const _morphIn: Eq<
		typeof T.t,
		(In: Expected) => {
			a: number;
			b?: number;
		}
	> = true;
});

it("morph out", () => {
	type Expected = { a: number; b?: number };
	const T = declare<Expected, { side: "out" }>().type({
		a: "string.numeric.parse",
		"b?": "number",
	});

	const _morphOut: Eq<typeof T.t, (In: { a: string; b?: number }) => Out<Expected>> = true;
});

it("value-optional", () => {
	type Expected = { f?: string };

	const T = type.declare<Expected>().type({
		f: "string?",
	});

	const _assert10: Eq<typeof T.t, Expected> = true;
});

// https://github.com/arktypeio/arktype/issues/1537
it("github undefined issue", () => {
	type Member = "a" | "b" | undefined; // without undefined it works
	const memberValidator = type.declare<Member>().type(`"a" | "b" | undefined`);

	type Object = {
		m: Member;
	};
	const objectValidator = type.declare<Object>().type({
		m: memberValidator,
	});

	const _assert11: Eq<typeof objectValidator.t, Object> = true;
});
