import { describe, expect, it } from "bun:test";
import { scope, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

it("tuple expression", () => {
	const description = "a series of characters";
	const types = scope({
		a: ["string", "@", description],
		b: {
			a: "a",
		},
	}).export();
	const _tupleAInference: Eq<typeof types.a.infer, string> = true;
	expect(types.a.description).toEqual(description);
	expect(types.a(1).toString()).toEqual("must be a series of characters (was a number)");
	const _tupleBInference: Eq<typeof types.b.infer, { a: string }> = true;
	expect(types.b({ a: true }).toString()).toEqual("a must be a series of characters (was boolean)");
});

it("tuple expression at path", () => {
	const description = "the number of dimensions in the monster group";
	const T = type({
		monster: ["196883", "@", description],
	});
	const _tuplePathInference: Eq<typeof T.infer, { monster: 196883 }> = true;
	expect(T.description).toEqual("{ monster: the number of dimensions in the monster group }");
	expect(T({ monster: 196882 }).toString()).toEqual(
		"monster must be the number of dimensions in the monster group (was 196882)",
	);
});

it("anonymous type config", () => {
	const T = type(type("true", "@", { description: "unfalse" }));
	const _anonymousConfigInference: Eq<typeof T.infer, true> = true;
	expect(T(false).toString()).toEqual("must be unfalse (was false)");
});

it("anonymous type config at path", () => {
	const Unfalse = type("true", "@", { description: "unfalse" });
	const T = type({ myKey: Unfalse });
	expect(T({ myKey: "500" }).toString()).toEqual(`myKey must be unfalse (was "500")`);
});

it("anonymous type thunk", () => {
	const T = type(() => type("false", "@", { description: "untrue" }));
	const _anonymousThunkInference: Eq<typeof T.infer, false> = true;
	expect(T.description).toEqual("untrue");
});

it("anonymous type thunk at path", () => {
	const T = type({
		myKey: () => type("false", "@", { description: "untrue" }),
	});
	const _anonymousThunkPathInference: Eq<typeof T.infer, { myKey: false }> = true;
	expect(T({ myKey: true }).toString()).toEqual("myKey must be untrue (was true)");
});

it("shallow node writer config", () => {
	const CustomOne = type("1", "@", {
		expected: ctx => `custom expected ${ctx.description}`,
		actual: data => `custom actual ${data}`,
		problem: ctx => `custom problem ${ctx.expected} ${ctx.actual}`,
		message: ctx => `custom message ${ctx.problem}`,
	});
	const _shallowWriterInference: Eq<typeof CustomOne.infer, 1> = true;
	expect(CustomOne(2).toString()).toEqual("custom message custom problem custom expected 1 custom actual 2");
});

it("string node configs", () => {
	const CustomTwo = type("2", "@", {
		expected: "2",
		actual: "something else",
		problem: "was terrible",
		message: "root was terrible",
	});
	const _stringConfigInference: Eq<typeof CustomTwo.infer, 2> = true;
	expect(CustomTwo(1).toString()).toEqual("root was terrible");
});

it("node writer config works on nested constraint", () => {
	const CustomEven = type("number % 2", "@", {
		expected: ctx => `custom expected ${ctx.description}`,
		actual: data => `custom actual ${data}`,
		problem: ctx => `custom problem ${ctx.expected} ${ctx.actual}`,
		message: ctx => `custom message ${ctx.problem}`,
	});
	const _nestedWriterInference: Eq<typeof CustomEven.infer, number> = true;
	expect(CustomEven(3).toString()).toEqual("custom message custom problem custom expected even custom actual 3");
});

it("applies config to shallow descendants", () => {
	const User = type({
		name: "string",
		age: "number",
	}).describe("a valid user");

	// should give the original error at a path
	expect(
		User({
			name: "david",
			age: true,
		}).toString(),
	).toEqual("age must be a number (was boolean)");

	// should give the shallow custom error
	expect(User(null).toString()).toEqual("must be a valid user (was null)");
});

it("docs actual example", () => {
	// avoid logging "was supersecret" for password
	const Password = type("string >= 8", "@", { actual: () => "" });

	const User = type({
		email: "string.email",
		password: Password,
	});

	const out = User({
		email: "david@arktype.io",
		password: "ez123",
	});

	expect(out.toString()).toEqual("password must be at least length 8");
});

it("docs message example", () => {
	const User = type({
		password: "string >= 8",
	}).configure({
		message: ctx => `${ctx.propString || "(root)"}: ${ctx.actual} isn't ${ctx.expected}`,
	});
	// ArkErrors: (root): a string isn't an object
	const out1 = User("ez123");
	expect(out1.toString()).toEqual("(root): a string isn't an object");
	// but `.configure` only applies shallowly, so the nested error isn't changed!
	// ArkErrors: password must be at least length 8 (was 5)
	const out2 = User({ password: "ez123" });
	expect(out2.toString()).toEqual("password must be at least length 8 (was 5)");
});

describe("select", () => {
	const Base = type({
		foo: "string",
		"bar?": {
			nested: "string",
			num: "number",
		},
	});

	it("self", () => {
		const T = Base.configure({ description: "root-only" }, "self");
		expect(T.description).toBe("root-only");
		expect(T("not an object").toString()).toBe("must be root-only (was a string)");
		expect(T({ foo: 5 }).toString()).toBe("foo must be a string (was a number)");
	});
	describe("completions", () => {
		// based on completion tests at ark/schema/select.test.ts
		it.todo("shallow completions");
		it.todo("composite key completions");
		it.todo("composite kind completions");
		it.todo("composite boundary completions");
		it.todo("composite method completions");
	});
});
