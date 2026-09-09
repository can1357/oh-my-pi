import { describe, expect, it } from "bun:test";
import { type ArkErrors, type Module, type Scope, scope, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

it("base definition", () => {
	const types = scope({ actual: { name: "string" } }).export();

	const Expected = type({
		name: "string",
	});

	const _assert1: Eq<typeof types.actual.t, typeof Expected.t> = true;
	expect(types.actual.expression).toEqual(Expected.expression);
	expect(() => scope({ a: "strong" }).export()).toThrow();
});

it("define", () => {
	const aliases = scope.define({ foo: "string", bar: { foo: "foo" } });
	expect(aliases).toEqual({ foo: "string", bar: { foo: "foo" } });
});

it("docs example", () => {
	const $ = type.scope({
		// built-in keywords are still available in your scope
		id: "string",
		// but you can also reference your own aliases directly!
		user: { id: "id", friends: "id[]" },
		// your aliases will be autocompleted alongside built-in keywords
		usersById: {
			"[id]": "user | undefined",
		},
	});

	$.export();

	const _assert2: Eq<
		typeof $,
		Scope<{
			id: string;
			user: {
				id: string;
				friends: string[];
			};
			usersById: {
				[x: string]:
					| {
							id: string;
							friends: string[];
					  }
					| undefined;
			};
		}>
	> = true;
});

it("type definition inline", () => {
	const $ = scope({ actual: type({ name: "string" }) });
	const types = $.export();

	const Expected = type({ name: "string" });

	const _assert3: Eq<typeof types.actual.t, typeof Expected.t> = true;
	expect(types.actual.expression).toEqual(Expected.expression);

	expect(() => scope({ a: type("strong") })).toThrow();
});

it("interdependent", () => {
	const types = scope({
		l: "string > 5",
		r: "string.email <= 10",
		actual: "l & r",
	}).export();

	const Expected = type("string.email <= 10 & string > 5");

	const _assert4: Eq<typeof types.actual.t, typeof Expected.t> = true;
	expect(types.actual.expression).toEqual(Expected.expression);
});

it("object tuple", () => {
	const types = scope({ ref: "string", actual: [{ c: "ref" }] }).export();
	const Expected = type([{ c: "string" }]);

	const _assert5: Eq<typeof types.actual.t, typeof Expected.t> = true;
	expect(types.actual.expression).toEqual(Expected.expression);
});

it("doesn't try to validate any in scope", () => {
	const $ = scope({ a: {} as any });
	const resolvedA = $.resolve("a");
	const _assert6: Eq<typeof resolvedA.infer, any> = true;

	const T = $.type(["number", "a"]);

	const _assert7: Eq<typeof T.infer, [number, any]> = true;
});

it("infers input and output", () => {
	const $ = scope({
		a: ["string", "=>", s => s.length],
	});
	const resolvedA = $.resolve("a");
	const _assert8: Eq<typeof resolvedA.infer, number> = true;
	const _assert9: Eq<typeof resolvedA.inferIn, string> = true;
});

it("infers its own helpers", () => {
	const $ = scope({
		a: () => $.type("string"),
		b: () => $.type("number"),
	});
	const types = $.export();

	const _assert10: Eq<typeof types.a.infer, string> = true;
	expect(types.a.expression).toEqual("string");
	expect(types.a.$.json).toEqual($.json);

	const _assert11: Eq<typeof types.b.infer, number> = true;
	expect(types.b.expression).toEqual("number");
	expect(types.b.$.json).toEqual($.json);
});

it("allows semantically valid helpers", () => {
	const $ = scope({
		n: () => $.type("number"),
		lessThan10: () => $.type("n<10"),
	});
	const types = $.export();

	const _assert12: Eq<typeof types.n.t, number> = true;
	expect(types.n.expression).toEqual("number");

	const Expected = type("number").lessThan(10);

	const _assert13: Eq<typeof types.lessThan10.t, typeof Expected.t> = true;
	expect(types.lessThan10.expression).toEqual(Expected.expression);
});

it("errors on helper parse error", () => {
	expect(() => {
		const $ = scope({
			a: () => $.type("kung|foo"),
		});
		$.export();
	}).toThrow();
});

it("errors on semantically invalid helper", () => {
	expect(() => {
		const $ = scope({
			b: () => $.type("boolean"),
			lessThan10: () => $.type("b<10"),
		});
		$.export();
	}).toThrow();
});

it("errors on ridiculous unexpected alias scenario", () => {
	expect(() =>
		scope({
			Unexpected: {},
			User: {
				// Previously, using the alias `Unexpected` allowed creating
				// this type string which matched its own error message.
				name: "Unexpected character 'c'",
			},
		}).export(),
	).toThrow();
});

it.todo("autocompletion");

it("cross-scope reference", () => {
	const { Apple } = scope({
		Apple: {
			pear: "Pear",
		},
		Pear: {
			tasty: "true",
		},
	}).export();

	const { X } = scope({
		X: Apple,
	}).export();

	const out = X({ pear: { tasty: true } });
	expect(out).toEqual({ pear: { tasty: true } });
});

describe("cyclic", () => {
	it("base", () => {
		const types = scope({ a: { b: "b" }, b: { a: "a" } }).export();

		const a = {} as { b: typeof b };
		const b = { a };
		a.b = b;

		expect(types.a(a)).toEqual(a);
		expect(types.a({ b: { a: { b: { a: 5 } } } }).toString()).toBe("b.a.b.a must be an object (was a number)");

		// Type hint displays as "..." on hitting cycle (or any if "noErrorTruncation" is true)
		void ({} as typeof types.a.infer);
		void ({} as typeof types.b.infer.a.b.a.b.a.b.a);

		void ({} as typeof types.a.infer.b.a.b.c);
	});

	const getCyclicScope = () =>
		scope({
			package: {
				name: "string",
				"dependencies?": "package[]",
				"contributors?": "contributor[]",
			},
			contributor: {
				email: "string.email",
				"packages?": "package[]",
			},
		});

	type Package = { name: string; dependencies?: Package[]; contributors?: { email: string; packages?: Package[] }[] };

	const getCyclicData = () => {
		const packageData = {
			name: "arktype",
			dependencies: [{ name: "typescript" }],
			contributors: [{ email: "david@arktype.io" }],
		} satisfies Package;
		packageData.dependencies.push(packageData);
		return packageData;
	};

	it("cyclic intersection", () => {
		const types = scope({
			a: { b: "b&a" },
			b: { a: "a&b" },
		}).export();
		void types.a.t;
		void types.b.t;
	});

	it("cyclic union", () => {
		const types = scope({
			a: { b: "b|false" },
			b: { a: "a|true" },
		}).export();
		void types.a.t;
		void types.b.t;
	});

	it("allows valid", () => {
		const types = getCyclicScope().export();
		const data = getCyclicData();
		const out = types.package(data);
		expect(out).toBe(data);
		expect((out as Package).dependencies?.[1]).toBe(data);
	});

	it("adds errors on invalid", () => {
		const types = getCyclicScope().export();
		const data = getCyclicData();
		data.contributors[0].email = "ssalbdivad";
		// ideally would only include one error, see:
		// https://github.com/arktypeio/arktype/issues/924
		expect(types.package(data).toString())
			.toBe(`dependencies[1].contributors[0].email must be an email address (was "ssalbdivad")
contributors[0].email must be an email address (was "ssalbdivad")`);
	});

	it("can include cyclic data in message", () => {
		const data = getCyclicData();
		const nonSelfDependent = getCyclicScope().type([
			"package",
			":",
			p => !p.dependencies?.some(d => d.name === p.name),
		]);
		expect(nonSelfDependent(data).toString()).toBe(
			'must be valid according to an anonymous predicate (was {"name":"arktype","dependencies":[{"name":"typescript"},"(cycle)"],"contributors":[{"email":"david@arktype.io"}]})',
		);
	});

	it("intersect cyclic reference", () => {
		const types = scope({
			arf: {
				b: "bork",
			},
			bork: {
				c: "arf&bork",
			},
		}).export();
		void types.arf.infer;
		void types.bork.infer;

		const a = {} as typeof types.arf.infer;
		const b = { c: {} } as typeof types.bork.infer;
		a.b = b;
		b.c.b = b;
		b.c.c = b.c;

		expect(types.arf(a)).toEqual(a);
		expect(types.arf({ b: { c: {} } }).toString()).toBe("b.c.b must be bork (was missing)");
	});

	it("union cyclic reference", () => {
		const types = scope({
			a: {
				b: "b",
			},
			b: {
				a: "a|3",
			},
		}).export();
		void types.a.infer;

		const valid: typeof types.a.infer = { b: { a: 3 } };

		expect(types.a(valid)).toEqual(valid);

		valid.b.a = valid;

		// check cyclic
		expect(types.a(valid)).toEqual(valid);

		expect(types.a({ b: { a: { b: { a: 4 } } } }).toString()).toBe("b.a.b.a must be a or 3 (was a number)");

		void types.b.infer;
	});

	// https://github.com/arktypeio/arktype/issues/1138
	it("cyclic array", () => {
		type Value = boolean | number | string | { [k: string]: Value } | Value[];

		const types = scope({
			primitive: "boolean | number | string",
			record: {
				"[string]": "value",
			},
			value: "primitive | record | value[]",
			castValue: "value" as type.cast<Value>,
		}).export();

		// TS type display blows up but it's equivalent to Value
		const out = types.value(5);
		// casting to Value also works
		const castOut = types.value(5);

		const _assert14: Eq<typeof out, Value | ArkErrors> = true;
		expect(out).toEqual(5);
		const _assert15: Eq<typeof castOut, Value | ArkErrors> = true;
		expect(castOut).toEqual(5);
	});
});

it("can override ambient aliases", () => {
	const types = scope({
		foo: {
			bar: "string",
		},
		string: type.number,
	}).export();
	const _assert16: Eq<
		typeof types,
		Module<{
			string: number;
			foo: {
				bar: number;
			};
		}>
	> = true;
	expect(types.foo({ bar: 1 })).toEqual({ bar: 1 });
	expect(types.foo({ bar: "1" }).toString()).toBe("bar must be a number (was a string)");
});

it("module", () => {
	const types = type.module({
		foo: "string",
		bar: "number",
	});
	const _assert17: Eq<
		typeof types,
		Module<{
			foo: string;
			bar: number;
		}>
	> = true;
	expect(types.foo("ok")).toBe("ok");
	expect(types.bar(1)).toBe(1);
});
