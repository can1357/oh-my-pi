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

it("bad element", () => {
	void declare<[string, number]>().type(["string", "boolean"]);
});

it("too short", () => {
	void declare<[string, number]>().type(["string"]);
});

it("too long", () => {
	void declare<[string, number]>().type(["string", "number", "number"]);
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

it("bad tuple expression", () => {
	void declare<"foo" | "bar">().type(["'foo'", "|", "'baz'"]);
});

it("narrower", () => {
	void (() => declare<string>().type("'foo'"));
});

it("narrower in object (from docs)", () => {
	type Expected = { a: string; b?: number };
	void (() =>
		type.declare<Expected>().type({
			a: "string",
			"b?": "1",
		}));
});

it("wider", () => {
	void (() =>
		declare<{ a: string }>().type({
			a: "unknown",
		}));
});

it("missing key", () => {
	void (() =>
		declare<{ a: string; b: number }>().type({
			a: "string",
		}));
});

it("missing optional key", () => {
	void (() =>
		declare<{ a: string; b?: number }>().type({
			a: "string",
		}));
});

it("empty object optional", () => {
	type Expected = { f?: string };

	void (() => type.declare<Expected>().type({}));
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

it("undefined as invalid optional value", () => {
	type Expected = { f?: string };

	void (() => declare<Expected>().type({ "f?": "string | undefined" }));
});

it("extraneous key", () => {
	void (() =>
		declare<{ a: string }>().type({
			a: "string",
			b: "boolean",
		}));
});

it.todo("completions");

it.todo("nested completions");

it("missing generic argument", () => {
	void (() => declare().type({}));
});

it("morph", () => {
	type Expected = { a: string; b?: number };
	void (() =>
		declare<Expected>().type({
			a: "string.numeric.parse",
			"b?": "number",
		}));
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

it("morph in mismatch", () => {
	type Expected = { a: number; b?: number };
	void (() =>
		declare<Expected, { side: "in" }>().type({
			a: "string.numeric.parse",
			"b?": "number",
		}));
});

it("morph out", () => {
	type Expected = { a: number; b?: number };
	const T = declare<Expected, { side: "out" }>().type({
		a: "string.numeric.parse",
		"b?": "number",
	});

	const _morphOut: Eq<typeof T.t, (In: { a: string; b?: number }) => Out<Expected>> = true;
});

it("morph out mismatch", () => {
	type Expected = { a: string; b?: number };
	void (() =>
		declare<Expected, { side: "out" }>().type({
			a: "string.numeric.parse",
			"b?": "number",
		}));
});

it("value-optional", () => {
	type Expected = { f?: string };

	const T = type.declare<Expected>().type({
		f: "string?",
	});

	const _assert10: Eq<typeof T.t, Expected> = true;
});

it("invalid value-optional", () => {
	type Expected = { f?: string };

	void (() =>
		type.declare<Expected>().type({
			f: "number?",
		}));
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
