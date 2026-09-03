import { describe, expect, it } from "bun:test";
import { scope, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

describe("standalone", () => {
	it("unary", () => {
		const boxOf = type("<t>", { box: "t" });

		const SchrodingersBox = boxOf({ cat: { isAlive: "boolean" } });

		const Expected = type({
			box: {
				cat: { isAlive: "boolean" },
			},
		});
		const _attestActual78 = SchrodingersBox.t;
		const _attestType78: Eq<typeof _attestActual78, typeof Expected.t> = true;

		expect(SchrodingersBox.json).toEqual(Expected.json);
	});

	it.todo("body completions");

	it.todo("args completions");

	it("binary", () => {
		const either = type("<first, second>", "first|second");
		const SchrodingersBox = either({ cat: { isAlive: "true" } }, { cat: { isAlive: "false" } });

		const Expected = type(
			{
				cat: {
					isAlive: "true",
				},
			},
			"|",
			{
				cat: {
					isAlive: "false",
				},
			},
		);
		const _attestActual74 = SchrodingersBox.t;
		const _attestType74: Eq<typeof _attestActual74, typeof Expected.t> = true;

		// ideally, this would be reduced to { cat: { isAlive: boolean } }:
		// https://github.com/arktypeio/arktype/issues/751
		expect(SchrodingersBox.json).toEqual(Expected.json);
	});

	it("referenced from other scope", () => {
		const types = scope({
			arrayOf: type("<t>", "t[]"),
		}).export();

		const StringArray = types.arrayOf("string");
		const Expected = type("string[]");
		const _attestActual72 = StringArray.t;
		const _attestType72: Eq<typeof _attestActual72, typeof Expected.t> = true;

		expect(StringArray.json).toEqual(Expected.json);
	});

	it("this not resolvable in generic def", () => {
		expect(() =>
			// @ts-expect-error
			type("<t>", {
				box: "t | this",
			}),
		).toThrow();
	});

	it("this in arg", () => {
		const boxOf = type("<t>", {
			box: "t",
		});

		const T = boxOf({
			a: "string | this",
		});

		expect(String(T.expression)).toMatch(/{ box: { a: string \| .* } }/);
		expect(T.allows({ box: { a: { a: "leaf" } } })).toBe(true);
		expect(T.allows({ box: { a: 1 } })).toBe(false);
	});

	it("rejects too few args", () => {
		const pair = type("<a, b>", ["a", "b"]);
		expect(() => pair("string")).toThrow();
	});

	it("rejects too many args", () => {
		const pair = type("<a, b>", ["a", "b"]);
		expect(() => pair("string", "number", "boolean")).toThrow();
	});
});

describe("constraints", () => {
	const testNonEmpty = (nonEmpty: (definition: unknown) => { readonly expression: string }) => {
		const T = nonEmpty("number[]");
		const Expected = type("number[] > 0");

		expect(T.expression).toEqual(Expected.expression);
	};

	it("can apply constraints to parameters", () => {
		const nonEmpty = type("<arr extends unknown[]>", "arr > 0");
		testNonEmpty(nonEmpty);
	});

	it("can apply constraints with whitespace", () => {
		const nonEmpty = type("<   arr     extends    unknown  []>", "arr > 0");
		testNonEmpty(nonEmpty);
	});

	it("constrained constraint", () => {
		const positiveToInteger = type("<n extends number > 0>", "n % 1");

		const T = positiveToInteger("number > 0");
		const Expected = type("number.integer > 0");
		const _attestActual63 = T.t;
		const _attestType63: Eq<typeof _attestActual63, typeof Expected.t> = true;

		expect(T.expression).toEqual(Expected.expression);

		expect(() => positiveToInteger("number")).toThrow();
	});

	it("unsatisfied parameter string", () => {
		const $ = scope({
			"entry<k extends Key, v>": ["k", "v"],
			foobar: "entry<'foo', 'bar'>",
		});

		const types = $.export();

		const Expected = type(["'foo'", "'bar'"]);
		const _attestActual60 = types.foobar.t;
		const _attestType60: Eq<typeof _attestActual60, typeof Expected.t> = true;

		expect(types.foobar.expression).toEqual(Expected.expression);

		// @ts-expect-error
		expect(() => $.type("entry<0, 1>")).toThrow();
	});

	it("can parse constraint including alias from current scope", () => {
		const $ = scope({
			"entry<k extends key, v>": ["k", "v"],
			key: "string | symbol",
		});

		const types = $.export();

		const Ok = types.entry("string", "number");
		const _attestActual57 = Ok.t;
		const _attestType57: Eq<typeof _attestActual57, [string, number]> = true;

		expect(Ok.expression).toEqual("[string, number]");

		// @ts-expect-error
		expect(() => types.entry("boolean", "number")).toThrow();
	});

	it("errors on unsatisfied constraints from current scope", () => {
		expect(() =>
			scope({
				"entry<k extends specialKey, v>": ["k", "v"],
				specialKey: "string | symbol",
				goodEntry: "entry<'foo', 1>",
				// @ts-expect-error
				badEntry: "entry<1, 0>",
			}).export(),
		).toThrow();
	});

	it("constraint parse error", () => {
		expect(() => {
			// @ts-expect-error
			type("<n extends nummer>", "n > 0");
		}).toThrow();
	});

	it("constraint semantic parse error", () => {
		expect(() => {
			// @ts-expect-error
			type("<boo extends boolean > 0>", "boo");
		}).toThrow();
	});

	it("default constraint is unknown", () => {
		// @ts-expect-error
		expect(() => type("<arr>", "arr > 0")).toThrow();
	});
});

describe("scoped", () => {
	const _setup = () => {
		const $ = scope({
			"box<t,u>": {
				box: "t|u",
			},
			bitBox: "box<0,1>",
		});

		return { $, types: $.export() };
	};
	it("referenced in scope", () => {
		const { types } = _setup();
		const Expected = type({ box: "0|1" });
		expect(types.bitBox.json).toEqual(Expected.json);

		const _attestActual49 = types.bitBox.t;
		const _attestType49: Eq<typeof _attestActual49, typeof Expected.t> = true;
	});

	it("nested", () => {
		const { $ } = _setup();
		const T = $.type("box<0|1, box<'one', 'zero'>>");

		const Expected = type({ box: ["0|1", "|", { box: "'one'|'zero'" }] });
		const _attestActual48 = T.t;
		const _attestType48: Eq<typeof _attestActual48, typeof Expected.t> = true;

		expect(T.json).toEqual(Expected.json);
	});

	it("in expression", () => {
		const { $ } = _setup();
		const T = $.type("string | box<0, 1> | boolean");

		const Expected = type("string", "|", { box: "0|1" }).or("boolean");
		const _attestActual46 = T.t;
		const _attestType46: Eq<typeof _attestActual46, typeof Expected.t> = true;

		expect(T.json).toEqual(Expected.json);
	});

	it("right bounds", () => {
		const { $ } = _setup();
		// should be able to differentiate between > that is part of a right
		// bound and > that closes a generic instantiation
		const T = $.type("box<number>5, string>=7>");

		const Expected = type({
			box: "number>5|string>=7",
		});
		const _attestActual44 = T.t;
		const _attestType44: Eq<typeof _attestActual44, typeof Expected.t> = true;

		expect(T.json).toEqual(Expected.json);
	});

	it("unclosed instantiation", () => {
		const { $ } = _setup();
		// @ts-expect-error
		expect(() => $.type("box<0,  1")).toThrow();
	});

	it("extra >", () => {
		const { $ } = _setup();
		expect(() =>
			// @ts-expect-error
			$.type("box<0,  1>>"),
		).toThrow();
	});

	it("too few args", () => {
		const { $ } = _setup();
		expect(() =>
			// @ts-expect-error
			$.type("box<0,box<2 | 3>>"),
		).toThrow();
	});

	it("too many args", () => {
		const { $ } = _setup();
		expect(() =>
			// @ts-expect-error
			$.type("box<0, box<1, 2, 3>>"),
		).toThrow();
	});

	it("syntactic error in arg", () => {
		const { $ } = _setup();
		expect(() =>
			// @ts-expect-error
			$.type("box<1, number%0>"),
		).toThrow();
	});

	it("semantic error in arg", () => {
		const { $ } = _setup();
		expect(() =>
			// @ts-expect-error
			$.type("box<1,string%2>"),
		).toThrow();
	});

	it("parameter supercedes alias with same name", () => {
		const types = scope({
			"box<Foo>": {
				box: "Foo|Bar",
			},
			Foo: "'foo'",
			Bar: "'bar'",
		}).export();

		const T = types.box("'baz'");

		const Expected = type({ box: "'baz' | 'bar'" });
		const _attestActual36 = T.t;
		const _attestType36: Eq<typeof _attestActual36, typeof Expected.t> = true;

		expect(T.json).toEqual(Expected.json);
	});

	it("declaration and instantiation leading and trailing whitespace", () => {
		const types = scope({
			"box< a , b >": {
				box: " a | b ",
			},
			actual: "  box  < 'foo'  ,   'bar'  > ",
		}).export();

		const Expected = type({
			box: "'foo' | 'bar'",
		});
		const _attestActual34 = types.actual.t;
		const _attestType34: Eq<typeof _attestActual34, typeof Expected.t> = true;

		expect(Expected.json).toEqual(types.actual.json);
	});

	it("allows external scope reference to be resolved", () => {
		const types = scope({
			external: "'external'",
			"orExternal<t>": "t|external",
		}).export();

		const b = scope({
			orExternal: types.orExternal,
			internal: "orExternal<'internal'>",
		}).export();

		const Expected = type("'internal' | 'external'");
		const _attestActual32 = b.internal.t;
		const _attestType32: Eq<typeof _attestActual32, typeof Expected.t> = true;

		expect(b.internal.json).toEqual(Expected.json);
	});

	it("empty string in declaration", () => {
		expect(() =>
			scope({
				// @ts-expect-error
				"box<t,,u>": "string",
			}).export(),
		).toThrow();
	});
});

it.todo("args completions from type");

describe("standalone", () => {
	const _genericSetup = () =>
		type.generic([
			"t",
			{
				foo: "number",
			},
		])({ boxOf: "t" });
	it("valid", () => {
		const g = _genericSetup();
		const T = g({
			foo: "number",
		});

		const Expected = type({
			boxOf: {
				foo: "number",
			},
		});
		const _attestActual28 = T.t;
		const _attestType28: Eq<typeof _attestActual28, typeof Expected.t> = true;

		expect(T.expression).toEqual(Expected.expression);
	});

	it("invalid", () => {
		const g = _genericSetup();
		expect(() =>
			// @ts-expect-error
			g({
				foo: "string",
			}),
		).toThrow();
	});

	it.todo("completions in instantiation");

	it.todo("completions in contraint");

	it("is available on type", () => {
		const nonEmpty = type.generic(["s", "string"])("s > 0");

		const Expected = type("string.alpha > 0");
		const actual = nonEmpty("string.alpha");
		const _attestActual23 = actual;
		const _attestType23: Eq<typeof _attestActual23, typeof Expected> = true;

		expect(actual.expression).toEqual(Expected.expression);
	});
});

describe("hkt", () => {
	it("builds a generic from a schema callback", () => {
		class MyExternalClass<T> {
			data: T;

			constructor(data: T) {
				this.data = data;
			}
		}

		const validateExternalGeneric = type.generic("T")(args =>
			type("instanceof", MyExternalClass).and({
				data: args.T,
			}),
		);

		const T = validateExternalGeneric({
			name: "string",
			age: "number",
		});

		const Expected = type("instanceof", MyExternalClass).and({
			data: {
				name: "string",
				age: "number",
			},
		});
		expect(T.json).toEqual(Expected.json);
	});

	it("builds callback generics with constrained parameters", () => {
		const validateExternalGeneric = type.generic(
			["S", "string"],
			["N", { value: "number" }],
		)(args => [args.S.atLeastLength(1), args.N]);

		const T = validateExternalGeneric("string", { value: "1" });
		expect(T.allows(["x", { value: 1 }])).toBe(true);
		expect(T.allows(["", { value: 1 }])).toBe(false);
		expect(() => validateExternalGeneric("string", { value: "string" })).toThrow();
	});
});

describe("cyclic", () => {
	it("preserves generic parameters across recursive instantiations", () => {
		const types = scope({
			"alternate<a, b>": {
				swap: "alternate<b, a>",
				order: ["a", "b"],
			},
			reference: "alternate<0, 1>",
		}).export();

		expect(typeof types.alternate).toBe("function");
		expect(types.reference.expression).toContain("order: [0, 1]");
		expect(types.reference.expression).toContain("order: [1, 0]");
		expect(types.reference.expression).toContain("alternate<0,1>");

		type Reference = typeof types.reference.infer;
		const _even: Eq<Reference["swap"]["swap"]["order"], [0, 1]> = true;
		const _odd: Eq<Reference["swap"]["swap"]["swap"]["order"], [1, 0]> = true;
		expect(_even && _odd).toBe(true);

		const fromCall = types.alternate("'off'", "'on'");
		expect(fromCall.expression).toContain('order: ["off", "on"]');
		expect(fromCall.expression).toContain('order: ["on", "off"]');
		expect(fromCall.expression).toMatch(/alternate<"(off|on)","(off|on)">/);
	});
});

describe("external", () => {
	it("supports generic helpers authored with type.validate", () => {
		const createBox = <const def>(of: type.validate<def>): type.instantiate<{ box: def }> =>
			type.raw({
				box: of,
			}) as never;

		const BoxType = createBox("string");
		const _type: Eq<typeof BoxType.t, { box: string }> = true;
		expect(_type).toBe(true);
		expect(BoxType.allows({ box: "value" })).toBe(true);
		expect(BoxType.allows({ box: 1 })).toBe(false);
	});

	it("surfaces invalid definitions from external generic helpers", () => {
		const createBox = <const def>(of: type.validate<def>) =>
			type.raw({
				box: of,
			});

		expect(() => createBox("nummer" as never)).toThrow();
	});
});
