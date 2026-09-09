import { expect, it } from "bun:test";
import { scope, type } from "@oh-my-pi/omptype/ark";

it("divisible", () => {
	const T = type("number%2");
	expect(T(4)).toEqual(4);
	expect(T(5).toString()).toEqual("must be a number divisible by 2 (was 5)");
});

it("range", () => {
	const T = type("number>2");
	expect(T(3)).toEqual(3);
	expect(T(2).toString()).toEqual("must be a number more than 2 (was 2)");
});

it("domain", () => {
	const T = type("number");
	expect(T(5)).toEqual(5);
	expect(T("foo").toString()).toEqual("must be a number (was a string)");
});

it("pattern", () => {
	const T = type("/.*@arktype.io/");
	expect(T("shawn@arktype.io")).toEqual("shawn@arktype.io");
	expect(T("shawn@hotmail.com").toString()).toEqual(
		'must be a string matching /.*@arktype.io/ (was "shawn@hotmail.com")',
	);
});

it("required keys", () => {
	const T = type({
		name: "string",
		age: "number",
		"title?": "string",
	});
	expect(T({ name: "Shawn", age: 99 })).toEqual({
		name: "Shawn",
		age: 99,
	});
	expect(T({ name: "Shawn" }).toString()).toEqual("age must be a number (was missing)");
});

it("customized built-in problem", () => {
	const types = scope(
		{ isEven: "number%2" },
		{
			divisor: {
				expected: ctx => `% ${ctx.rule} !== 0`,
				problem: ctx => `${ctx.actual} ${ctx.expected}`,
			},
		},
	).export();
	expect(types.isEven(3).toString()).toEqual("3 % 2 !== 0");
});

it("domains", () => {
	const T = type("string|number[]");
	expect(T([1])).toEqual([1]);
	expect(T("hello")).toEqual("hello");
	expect(T(2).toString()).toEqual("must be a string or an array (was a number)");
	expect(T({}).toString()).toEqual("must be a string or an array (was an object)");
});

it("tuple length", () => {
	const T = type(["string", "number", "string", "string[]"]);
	const data: typeof T.infer = ["foo", 5, "boo", []];
	expect(T(data)).toEqual(data);
	expect(T(["hello"]).toString()).toEqual("must be an array of at least length 4 (was an array)");
});

it("branches", () => {
	const T = type({ bar: "boolean" }, "|", { foo: "string" });
	expect(T({ foo: "ok" })).toEqual({ foo: "ok" });
	expect(T({ bar: true })).toEqual({ bar: true });
	expect(T({}).toString()).toEqual("bar must be boolean (was missing) or foo must be a string (was missing)");
	expect(T({ bar: "swapped", foo: true }).toString()).toEqual(
		'bar must be boolean (was "swapped") or foo must be a string (was true)',
	);
});

it("common errors collapse", () => {
	const T = type({ base: "1", a: "1" }, "|", { base: "1", b: "1" });
	expect(T({ base: 1, a: 1 })).toEqual({ base: 1, a: 1 });
	expect(T({ base: 1, b: 1 })).toEqual({ base: 1, b: 1 });
	expect(T({ a: 1, b: 1 }).toString()).toEqual("base must be 1 (was missing)");
});

it("branches at path", () => {
	const T = type({ key: [{ a: "string" }, "|", { b: "boolean" }] });
	expect(T({ key: { a: "ok" } })).toEqual({ key: { a: "ok" } });
	expect(T({ key: { b: true } })).toEqual({ key: { b: true } });
	expect(T({ key: {} }).toString()).toEqual(
		"key.a must be a string (was missing) or key.b must be boolean (was missing)",
	);
});

it("switch", () => {
	const T = type({ a: "string" }).or({ a: "null" }).or({ a: "number" });
	expect(T({ a: "ok" })).toEqual({ a: "ok" });
	expect(T({ a: 5 })).toEqual({ a: 5 });
	// value isn't present
	expect(T({}).toString()).toEqual("a must be a string, null or a number (was missing)");
	// unsatisfying value
	expect(T({ a: false }).toString()).toEqual("a must be a string, null or a number (was false)");
});

// previously was affected by a caching issue
// https://github.com/arktypeio/arktype/issues/962
it("multiple switch", () => {
	const types = scope({
		a: { foo: "string" },
		b: { foo: "number" },
		c: { foo: "Function" },
		d: "a|b|c",
	}).export();
	expect(types.d({}).toString()).toEqual("foo must be a string, a number or an object (was missing)");
	expect(types.d({ foo: null }).toString()).toEqual("foo must be a string, a number or an object (was null)");
});

it("serialized actual for discriminated union", () => {
	const T = type({ a: "'foo'" }).or({ a: "'bar'" });
	expect(T({ a: '"extra quotes"' }).toString()).toEqual('a must be "foo" or "bar" (was "\\"extra quotes\\"")');
	expect(T({ a: "" }).toString()).toEqual('a must be "foo" or "bar" (was "")');
	expect(T({ a: 5 }).toString()).toEqual('a must be "foo" or "bar" (was 5)');
});

it("multi", () => {
	const NaturalNumber = type("number.integer>0");
	expect(NaturalNumber(-1.2).toString()).toEqual(`(-1.2) must be...
  ◦ an integer
  ◦ positive`);
	const NaturalAtPath = type({
		natural: NaturalNumber,
	});
	expect(NaturalAtPath({ natural: -0.1 }).toString()).toEqual(`natural (-0.1) must be...
  ◦ an integer
  ◦ positive`);
});

it("multiple errors across paths", () => {
	const NaturalSchema = type({
		natural: "number.integer>0",
		name: "string",
	});
	const result = NaturalSchema({
		natural: -Math.PI,
		name: ["negative", "PI"],
	});
	expect(result.toString()).toEqual(`natural must be an integer (was -3.141592653589793)
natural must be positive (was -3.141592653589793)
name must be a string (was an object)`);
});

it("homepage example", () => {
	const User = type({
		name: "string",
		luckyNumbers: "(number | bigint)[]",
		"isAdmin?": "boolean | null",
	});

	const out = User({
		luckyNumbers: [31, "255", 1337n],
		isAdmin: 1,
	});

	expect(out.toString()).toEqual(`name must be a string (was missing)
luckyNumbers[1] must be a number or a bigint (was a string)
isAdmin must be boolean or null (was a number)`);
});

it("relative path", () => {
	const Signup = type({
		email: "string.email",
		password: "string",
		repeatPassword: "string",
	}).narrow(
		(d, ctx) =>
			d.password === d.repeatPassword ||
			ctx.reject({
				expected: "identical to password",
				actual: "",
				relativePath: ["repeatPassword"],
			}),
	);

	// ensure the relativePath is relative
	const NestedSignup = type({
		user: Signup,
	});

	const validSignup: typeof Signup.infer = {
		email: "david@arktype.io",
		password: "secure",
		repeatPassword: "secure",
	};

	const valid: typeof NestedSignup.infer = { user: validSignup };

	expect(NestedSignup(valid)).toEqual(valid);
	expect(
		NestedSignup({
			user: { ...validSignup, repeatPassword: "insecure" },
		}).toString(),
	).toEqual("user.repeatPassword must be identical to password");
});

// https://github.com/arktypeio/arktype/issues/1149
it("morphs apply when not at an error path, even on failed validation", () => {
	const AgeType = type("string.numeric.parse").to("number>18");
	const ObjType = type({ name: "string", "age?": AgeType });

	const out = ObjType({ name: 2, age: "2" });
	expect(out.toString()).toEqual(`name must be a string (was a number)
age must be a number more than 18 (was 2)`);
});

it("morphs don't apply when at an error path", () => {
	let callCount = 0;
	const T = type("unknown")
		.narrow((_data, ctx) => ctx.mustBe("valid"))
		.pipe(() => callCount++);

	const out = T(1);

	expect(out.toString()).toEqual("must be valid (was 1)");
	expect(callCount).toEqual(0);
});

it("morphs don't apply when under an error path", () => {
	let callCount = 0;
	const T = type({
		foo: ["unknown", "=>", () => callCount++],
	}).filter((_data, ctx) => ctx.mustBe("valid"));

	const out = T({ foo: 1 });

	expect(out.toString()).toEqual('must be valid (was {"foo":1})');
	expect(callCount).toEqual(0);
});

it("ctx.path docs example", () => {
	const symbolicKey = Symbol("ctxPathExampleSymbol");

	let path: PropertyKey[] | undefined;

	const notFoo = type.string.narrow((s, ctx) => {
		if (s !== "foo") return true;
		path = ctx.path.slice(0);
		return ctx.mustBe("not foo");
	});

	const Obj = type({
		stringKey: {
			[symbolicKey]: notFoo.array(),
		},
	});

	expect(Obj({ stringKey: { [symbolicKey]: ["bar", "foo"] } }).toString()).toEqual(
		'stringKey[Symbol(ctxPathExampleSymbol)][1] must be not foo (was "foo")',
	);
	expect(path).toEqual(["stringKey", "Symbol(ctxPathExampleSymbol)", 1]);
});
