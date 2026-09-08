import { describe, expect, it } from "bun:test";
import { scope, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "../type-assert";

describe("parsing and traversal", () => {
	it("base", () => {
		const fnDefaultTo5 = () => 5 as const;
		const O = type({
			a: "string",
			foo: "number = 5",
			bar: ["number", "=", 5],
			baz: ["number", "=", fnDefaultTo5],
		});

		const _typeBase: Eq<
			typeof O.t,
			{
				a: string;
				foo: Default<number, 5>;
				bar: Default<number, 5>;
				baz: Default<number, 5>;
			}
		> = true;
		const _type2: Eq<
			typeof O.inferIn,
			{
				a: string;
				foo?: number;
				bar?: number;
				baz?: number;
			}
		> = true;
		const _type3: Eq<typeof O.infer, { a: string; foo: number; bar: number; baz: number }> = true;

		expect(O({ a: "", foo: 4, bar: 4, baz: 4 })).toEqual({
			a: "",
			foo: 4,
			bar: 4,
			baz: 4,
		});
		expect(O({ a: "" })).toEqual({ a: "", foo: 5, bar: 5, baz: 5 });
		expect(O({ bar: 4 }).toString()).toBe("a must be a string (was missing)");
		expect(O({ a: "", bar: "" }).toString()).toBe("bar must be a number (was a string)");
	});

	// https://github.com/arktypeio/arktype/issues/1335
	it("jitless", () => {
		const types = type.module(
			{
				foo: {
					test: "string = 'test'",
				},
			},
			{ jitless: true },
		);

		expect(types.foo({})).toEqual({ test: "test" });
		expect(types.foo({ test: "provided" })).toEqual({ test: "provided" });
	});

	it("unions are defaultable", () => {
		const O = type({
			boo: "boolean = false",
		});
		// this should not distribute to Default<true, true> | Default<false, true>

		expect(O({})).toEqual({ boo: false });
		expect(O({ boo: true })).toEqual({ boo: true });
		expect(O({ boo: 5 }).toString()).toBe("boo must be boolean (was a number)");
	});

	it("validated default in scope", () => {
		const types = scope({
			specialNumber: "number",
			stringDefault: { foo: "string", bar: "specialNumber = 5" },
			tupleDefault: { foo: "string", bar: ["specialNumber", "=", 5] },
		}).export();

		const _type16: Eq<{
			foo: string;
			bar: Default<number, 5>;
		}> = true;

		const _type17: Eq<typeof types.tupleDefault.t, typeof types.stringDefault.t> = true;

		expect(types.stringDefault.json).toEqual({
			required: [{ key: "foo", value: "string" }],
			optional: [
				{
					default: 5,
					key: "bar",
					value: "number",
				},
			],
			domain: "object",
		});

		expect(types.tupleDefault.json).toEqual(types.stringDefault.json);
	});

	it("no shallow default in tuple expression", () => {
		expect(() =>
			// @ts-expect-error
			type(["string = 'foo'", "|", "number"]),
		).toThrow("default");

		expect(() =>
			// @ts-expect-error
			type(["string", "|", ["number", "=", 5]]),
		).toThrow("default");
	});

	it("no shallow default in scope", () => {
		// @ts-expect-error
		expect(() => type.module({ foo: "string = ''" })).toThrow("default");

		expect(() =>
			// @ts-expect-error
			type.module({ foo: ["string", "=", ""] }),
		).toThrow("default");
	});

	it("chained", () => {
		const DefaultedString = type("string").default("");

		const O = type({ a: DefaultedString });
		const _typeChained: Eq<typeof O.t, { a: Default<string, ""> }> = true;
		const _type26: Eq<typeof O.inferIn, { a?: string }> = true;
		const _type27: Eq<typeof O.infer, { a: string }> = true;
	});

	it("unassignable default tuple", () => {
		expect(() =>
			// @ts-expect-error
			type({ foo: "string", bar: ["number", "=", "5"] }),
		).toThrow("ParseError: Default for bar must be a number (was a string)");
	});

	it("unassignable default thunk tuple", () => {
		expect(() =>
			type({
				foo: [
					{ foo: "true" },
					"=",
					() => ({
						// @ts-expect-error
						foo: false,
					}),
				],
			}),
		).toThrow("ParseError: Default for foo.foo must be true (was false)");
	});

	it("unassignable default string", () => {
		// @ts-expect-error
		expect(() => type({ foo: "number = true" })).toThrow(
			"ParseError: Default for foo must be a number (was boolean)",
		);
	});

	it("morphed", () => {
		// https://discord.com/channels/957797212103016458/1280932672029593811/1283368602355109920
		const ProcessForm = type({
			bool_value: type("string")
				.pipe(v => v === "on")
				.default("off"),
		});

		const _typeMorphed: Eq<typeof ProcessForm.t, { bool_value: (In: Default<string, "off">) => Out<boolean> }> = true;

		const _type32: Eq<
			typeof ProcessForm.inferIn,
			{
				// key should still be distilled as optional even inside a morph
				bool_value?: string;
			}
		> = true;
		const _type33: Eq<
			typeof ProcessForm.infer,
			{
				bool_value: boolean;
			}
		> = true;

		const out = ProcessForm({});

		expect(out).toEqual({ bool_value: false });

		expect(ProcessForm({ bool_value: "on" })).toEqual({ bool_value: true });

		expect(ProcessForm({ bool_value: true }).toString()).toBe("bool_value must be a string (was boolean)");
	});

	it("primitive morph precomputed", () => {
		let callCount = 0;

		const toggle = (b: boolean) => {
			callCount++;
			return !b;
		};

		const T = type({
			blep: type("boolean").pipe(toggle).default(false),
		});

		const _typePrecomputed: Eq<typeof T.t, { blep: (In: Default<boolean, false>) => Out<boolean> }> = true;

		const out = T({});

		expect(out).toEqual({ blep: true });
		expect(callCount).toEqual(1);

		T({});
		expect(callCount).toEqual(1);
	});

	it("default preserved on pipe to node", () => {
		let callCount = 0;

		const toggle = (b: boolean) => {
			callCount++;
			return !b;
		};

		const T = type({
			blep: type("boolean").pipe(toggle).to("boolean").default(false),
		});

		const _typePipeTo: Eq<typeof T.t, { blep: (In: Default<boolean, false>) => To<boolean> }> = true;

		const out = T({});

		expect(out).toEqual({ blep: true });
		expect(callCount).toEqual(1);

		T({});
		expect(callCount).toEqual(1);
	});

	it("primitive morphed to object not premorphed", () => {
		const T = type({
			foo: type("string")
				.pipe(s => ({ nest: s }))
				.default("foo"),
		});
		const _typeMorphedObject: Eq<typeof T.t, { foo: (In: Default<string, "foo">) => Out<{ nest: string }> }> = true;

		const out = T.assert({});

		expect(out).toEqual({ foo: { nest: "foo" } });

		const originalOut = structuredClone(out);

		out.foo.nest = "baz";

		expect(T({})).toEqual(originalOut);
	});
});

describe("string parsing", () => {
	it("number", () => {
		const T = type({ key: "number = 42" });
		const Expected = type({ key: ["number", "=", 42] });

		const _type49: Eq<typeof T, typeof Expected> = true;
		expect(T.json).toEqual(Expected.json);
	});

	it("bigint", () => {
		const T = type({ key: "bigint = 100n" });
		const Expected = type({ key: ["bigint", "=", 100n] });

		const _type51: Eq<typeof T, typeof Expected> = true;
		expect(T.json).toEqual(Expected.json);
	});

	it("string", () => {
		const T = type({ key: 'string = "default value"' });
		const Expected = type({ key: ["string", "=", "default value"] });

		const _type53: Eq<typeof T, typeof Expected> = true;
		expect(T.json).toEqual(Expected.json);
	});

	it("Date", () => {
		const T = type({ key: 'Date = d"1993-05-21"' });

		const out = T.assert({});

		expect(out.key.toISOString()).toBe("1993-05-21T00:00:00.000Z");

		// we can't check expected here since the Date instance will not
		// have a narrowed literal type
		const _type56: Eq<{
			key: Default<Date, Date>;
		}> = true;
	});

	it("Date is immutable", () => {
		const T = type({ date: 'Date = d"1993-05-21"' });
		const v1 = T.assert({});
		const time = v1.date.getTime();
		v1.date.setMilliseconds(123);
		const v2 = T.assert({});
		expect(v2.date.getTime()).toEqual(time);
	});

	it("true", () => {
		const T = type({ key: "boolean = true" });
		const Expected = type({ key: ["boolean", "=", true] });

		const _type58: Eq<typeof T, typeof Expected> = true;
		expect(T.json).toEqual(Expected.json);
	});

	it("false", () => {
		const T = type({ key: "boolean = false" });
		const Expected = type({ key: ["boolean", "=", false] });

		const _type60: Eq<typeof T, typeof Expected> = true;
		expect(T.json).toEqual(Expected.json);
	});

	it("null", () => {
		// ideally we could infer a better type here,
		// but attaching attributes to null or undefined
		// is not possible with the current design
		const T = type({ key: "object | null = null" });
		const Expected = type({ key: ["object | null", "=", null] });

		const _type62: Eq<typeof T, typeof Expected> = true;
		expect(T.json).toEqual(Expected.json);
	});

	it("undefined", () => {
		const T = type({ key: "unknown = undefined" });
		const Expected = type({ key: ["unknown", "=", undefined] });

		expect(T({})).toEqual({ key: undefined });

		const _type65: Eq<typeof T, typeof Expected> = true;
		expect(T.json).toEqual(Expected.json);
	});

	it("incorrect default type", () => {
		// @ts-expect-error
		expect(() => type({ foo: "string", bar: "number = true" })).toThrow(
			"ParseError: Default for bar must be a number (was boolean)",
		);
	});

	it("non-literal", () => {
		expect(() =>
			// @ts-expect-error
			type({ foo: "string", bar: "unknown = number" }),
		).toThrow("default");
	});

	it("validated default in scope", () => {
		const $ = scope({
			specialNumber: "number",
			obj: { foo: "string", bar: "specialNumber = 5" },
		});

		$.export();
	});

	it("optional with default", () => {
		expect(() =>
			// @ts-expect-error
			type({ foo: "string", "bar?": "number = 5" }),
		).toThrow("default");

		expect(() =>
			// @ts-expect-error
			type({ foo: "string", "bar?": ["number", "=", 5] }),
		).toThrow("default");
	});

	it("index with default", () => {
		expect(() =>
			// @ts-expect-error
			type({ foo: "string", "[string]": "number = 5" }),
		).toThrow("default");

		expect(() =>
			// @ts-expect-error
			type({ foo: "string", "[string]": ["number", "=", 5] }),
		).toThrow("default");
	});

	it("shallow default", () => {
		// @ts-expect-error
		expect(() => type("string='foo'")).toThrow("default");

		// @ts-expect-error
		expect(() => type(["string", "=", "foo"])).toThrow("default");
	});

	it("defaultable input extracted as optional", () => {
		const T = type({ foo: "number = 0" });
		const _type76: Eq<typeof T.in.t, { foo?: number }> = true;
		const _type77: Eq<typeof T.inferIn, { foo?: number }> = true;

		expect(T.in.expression).toBe("{ foo?: number }");
	});

	it("defaultable output extracted as required", () => {
		const T = type({ foo: "number = 0" });
		const _type79: Eq<typeof T.out.t, { foo: number }> = true;
		const _type80: Eq<typeof T.inferOut, { foo: number }> = true;

		expect(T.out.expression).toBe("{ foo: number }");
	});

	// https://github.com/arktypeio/arktype/issues/1507
	it("fails on expression value", () => {
		expect(() =>
			type({
				// @ts-expect-error
				test: "'y' | 'n' = 'n' |> 'y'",
			}),
		).toThrow("unexpected");
	});
});

describe("works properly with types", () => {
	it("allows primitives and factories for anys", () => {
		const fn = () => {};
		const T = type({
			foo1: ["unknown", "=", true],
			bar1: ["unknown", "=", () => [true]],
			baz1: ["unknown", "=", () => fn],
			foo2: ["unknown.any", "=", true],
			bar2: ["unknown.any", "=", () => [true]],
			baz2: ["unknown.any", "=", () => fn],
		});
		const out = T.assert({});
		expect(out).toEqual({
			foo1: true,
			bar1: [true],
			baz1: fn,
			foo2: true,
			bar2: [true],
			baz2: fn,
		});
	});
	it("disallows plain objects for anys", () => {
		expect(() => {
			// @ts-expect-error
			type({ foo: ["unknown", "=", { foo: "bar" }] });
		}).toThrow("default");

		expect(() => {
			// @ts-expect-error
			type({ foo: ["unknown.any", "=", { foo: "bar" }] });
		}).toThrow("default");
	});

	it("allows string subtyping", () => {
		type({
			foo: [/^foo/ as type.cast<`foo${string}`>, "=", "foobar"],
			bar: [/bar$/ as type.cast<`${string}bar`>, "=", () => "foobar" as const],
		});
	});

	describe("bad values", () => {
		it("primitive", () => {
			expect(
				// @ts-expect-error
				() => type({ foo: ["number", "=", true] }),
			).toThrow("ParseError: Default for foo must be a number (was boolean)");
		});

		it("array", () => {
			expect(
				// @ts-expect-error
				() => type({ foo: ["number[]", "=", true] }),
			).toThrow("ParseError: Default for foo must be an array (was boolean)");
		});

		it("object", () => {
			expect(
				// @ts-expect-error
				() => type({ foo: [{ bar: "false" }, "=", true] }),
			).toThrow("ParseError: Default for foo must be an object (was boolean)");
		});

		it("union", () => {
			expect(
				// @ts-expect-error
				() => type({ foo: [["number[]", "|", "string"], "=", true] }),
			).toThrow("ParseError: Default for foo must be an array or a string (was boolean)");
		});

		it("union with default", () => {
			// should not cause "instantiation is excessively deep"
			expect(
				// @ts-expect-error
				() => type("number[]", "|", "string").default(true),
			).toThrow("ParseError: Default must be an array or a string (was boolean)");
		});

		it("union with default function", () => {
			// should not cause "instantiation is excessively deep"
			expect(
				// @ts-expect-error
				() => type("number[]", "|", "string").default(() => true),
			).toThrow("ParseError: Default must be an array or a string (was boolean)");
		});
	});

	describe("morph input errors", () => {
		it("string", () => {
			// @ts-expect-error
			expect(() => type({ foo: ["string.numeric.parse = true"] })).toThrow("must be a string (was boolean)");
		});

		it("tuple", () => {
			// @ts-expect-error
			expect(() => type({ foo: ["string.numeric.parse", "=", true] })).toThrow("must be a string (was boolean)");
		});

		it("function", () => {
			// @ts-expect-error
			expect(() => type({ foo: ["string.numeric.parse", "=", () => true] })).toThrow(
				"must be a string (was boolean)",
			);
		});

		it("reference tuple", () => {
			const Numtos = type("number").pipe(s => `${s}`);
			// @ts-expect-error
			expect(() => type({ foo: [Numtos, "=", true] })).toThrow("must be a number (was boolean)");
		});

		it("reference function", () => {
			const Numtos = type("number").pipe(s => `${s}`);
			// @ts-expect-error
			expect(() => type({ foo: [Numtos, "=", () => true] })).toThrow("must be a number (was boolean)");
		});
	});

	it("morphed inputs", () => {
		const Numtos = type("number").pipe(s => `${s}`);
		const F = type({
			foo1: "string.numeric.parse = '123'",
			foo2: ["string.numeric.parse", "=", "123"],
			foo3: ["string.numeric.parse", "=", () => "123"],
			bar1: [Numtos, "=", 123],
			bar2: [Numtos, "=", () => 123],
			baz1: type(Numtos).default(123),
		});
		expect(F.assert({})).toEqual({
			foo1: 123,
			foo2: 123,
			foo3: 123,
			bar1: "123",
			bar2: "123",
			baz1: "123",
		});
	});

	it("pipes from undefined or not present", () => {
		const defaultDate = new Date("2020-01-01");

		const ParsedDate = type("string | undefined").pipe((input: string | undefined) =>
			input ? new Date(input) : defaultDate,
		);

		const SearchSchema = type({
			week: ParsedDate.default(defaultDate.toISOString()),
		});

		expect(SearchSchema({ week: "2023-01-01" })).toEqual({
			week: new Date("2023-01-01"),
		});

		expect(SearchSchema({ week: undefined })).toEqual({
			week: defaultDate,
		});

		expect(SearchSchema({})).toEqual({ week: defaultDate });
	});
});

describe("intersection", () => {
	it("two optionals, one default", () => {
		const L = type({ bar: ["number", "=", 5] });
		const R = type({ "bar?": "5" });

		const T = L.and(R);
		expect(T({})).toEqual({ bar: 5 });
		expect(T({ bar: 5 })).toEqual({ bar: 5 });
	});

	it("same default", () => {
		const L = type({ bar: ["number", "=", 5] });
		const R = type({ bar: ["5", "=", 5] });

		const T = L.and(R);
		expect(T({})).toEqual({ bar: 5 });
		expect(T({ bar: 5 })).toEqual({ bar: 5 });
	});

	it("removed when intersected with required", () => {
		const L = type({ bar: ["number", "=", 5] });
		const R = type({ bar: "number" });

		const T = L.and(R);
		expect(T({}).toString()).toBe("bar must be a number (was missing)");
		expect(T({ bar: 7 })).toEqual({ bar: 7 });
	});

	it("errors on multiple defaults", () => {
		const L = type({ bar: ["number", "=", 5] });
		const R = type({ bar: ["number", "=", 6] });
		expect(() => L.and(R)).toThrow("ParseError: Invalid intersection of default values 5 & 6");
	});
});

describe("functions", () => {
	it("works in tuple", () => {
		const T = type({ foo: ["string", "=", () => "bar" as const] });

		const _typeTupleFactory: Eq<typeof T.t, { foo: Default<string, "bar"> }> = true;
		expect(T.assert({ foo: "bar" })).toEqual({ foo: "bar" });
	});

	it("checks the returned value", () => {
		expect(() => {
			// @ts-expect-error
			type({ foo: ["number", "=", () => "bar"] });
		}).toThrow("ParseError: Default for foo must be a number (was a string)");

		expect(() => {
			// @ts-expect-error
			type({ foo: ["number[]", "=", () => "bar"] });
		}).toThrow("ParseError: Default for foo must be an array (was a string)");

		expect(() => {
			// @ts-expect-error
			type({ foo: [{ a: "number" }, "=", () => ({ a: "bar" })] });
		}).toThrow("ParseError: Default for foo.a must be a number (was a string)");
	});

	it("morphs the returned value", () => {
		const T = type({ foo: ["string.numeric.parse", "=", () => "123"] });

		const _typeMorphFactory: Eq<typeof T.t, { foo: (In: Default<string, string>) => To<number> }> = true;
		expect(T.assert({})).toEqual({ foo: 123 });
	});

	it("only allows argless functions for factories", () => {
		expect(() => {
			// @ts-expect-error
			type({ bar: ["Function", "=", class {}] });
		}).toThrow("Cannot call a class constructor without |new|");
		expect(() => {
			// @ts-expect-error
			type({ bar: ["number", "=", (a: number) => a] });
		}).toThrow("must be a number");
	});

	it("default factory may return different values", () => {
		let i = 0;
		const T = type({ bar: type("number[]").default(() => [++i]) });
		expect(T.assert({}).bar).toEqual([3]);
		expect(T.assert({}).bar).toEqual([4]);
	});

	it("default function factory", () => {
		let i = 0;
		const T = type({
			bar: type("Function").default(() => {
				const j = ++i;
				return () => j;
			}),
		});

		const _typeFunctionFactory: Eq<typeof T.t, { bar: Default<Function, () => number> }> = true;
		expect(T.assert({}).bar()).toEqual(3);
		expect(T.assert({}).bar()).toEqual(4);
	});

	it("allows union factory", () => {
		let i = 0;
		const T = type({
			foo: [["number", "|", "number[]"], "=", () => (i % 2 ? ++i : [++i])],
		});
		expect(T.assert({})).toEqual({ foo: 2 });
		expect(T.assert({})).toEqual({ foo: [3] });
	});

	it("default array", () => {
		const T = type({
			foo: type("number[]").default(() => [1]),
			bar: type("number[]")
				.pipe(v => v.map(e => e.toString()))
				.default(() => [1]),
		});
		const v1 = T.assert({});
		const v2 = T.assert({});
		expect(v1).toEqual({ foo: [1], bar: ["1"] });
		expect(v1.foo !== v2.foo).toBe(true);
	});

	it("default array is checked", () => {
		expect(() => {
			// @ts-expect-error
			type({ bar: type("number[]").default(() => ["a"]) });
		}).toThrow("ParseError: Default value at [0] must be a number (was a string)");

		expect(() => {
			type({
				baz: type("number[]")
					.pipe(v => v.map(e => e.toString()))
					// @ts-expect-error
					.default(() => ["a"]),
			});
		}).toThrow("ParseError: Default value at [0] must be a number (was a string)");
	});

	it("default object", () => {
		const T = type({
			foo: type({ "foo?": "string" }).default(() => ({})),
			bar: type({ "foo?": "string" }).default(() => ({ foo: "foostr" })),
			baz: type({ foo: "string = 'foostr'" }).default(() => ({})),
		});

		const v1 = T.assert({}),
			v2 = T.assert({});

		expect(v1).toEqual({
			foo: {},
			bar: { foo: "foostr" },
			baz: { foo: "foostr" },
		});
		expect(v1.foo !== v2.foo).toBe(true);
	});

	it("default object is checked", () => {
		expect(() => {
			// @ts-expect-error
			type({ foo: type({ foo: "string" }).default({}) });
		}).toThrow("default");

		expect(() => {
			type({
				// @ts-expect-error
				bar: type({ foo: "number" }).default(() => ({ foo: "foostr" })),
			});
		}).toThrow("ParseError: Default foo must be a number (was a string)");
	});
});

it("extracted from cyclic type", () => {
	const T = type({
		defaulted: "number = 0",
		"nested?": "this",
	});

	const t = T.assert({});

	expect(t).toEqual({ defaulted: 0 });

	const _type128: Eq<typeof t.defaulted, number> = true;
	const nestedDefaulted = t.nested?.defaulted;
	const _type129: Eq<typeof nestedDefaulted, number | undefined> = true;
});
