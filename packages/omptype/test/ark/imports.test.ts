import { describe, expect, it } from "bun:test";
import { type BoundModule, type Module, scope, type Type, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

describe("threeSixtyNoScope", () => {
	const threeSixtyNoScope = scope({
		three: "3",
		sixty: "60",
		no: "'no'",
	});
	const threeSixtyNoModule = threeSixtyNoScope.export();

	const yesScope = scope({ yes: "'yes'" });
	const yesModule = yesScope.export();

	it("single", () => {
		const types = scope({
			...threeSixtyNoModule,
			threeSixtyNo: "three|sixty|no",
		}).export();

		const _assert1: Eq<
			typeof types,
			Module<{
				three: 3;
				sixty: 60;
				no: "no";
				threeSixtyNo: 3 | 60 | "no";
			}>
		> = true;
	});

	it("multiple", () => {
		const base = scope({
			...threeSixtyNoModule,
			...yesModule,
			extra: "true",
		});

		const imported = scope({
			...base.import(),
			a: "three|sixty|no|yes|extra",
		});

		const exports = imported.export();

		expect(Object.keys(exports)).toEqual(["a"]);
		expect(exports.a.expression).toBe('3 | 60 | "no" | "yes" | true');

		const _assert2: Eq<typeof exports, Module<{ a: 3 | 60 | "no" | "yes" | true }>> = true;
	});

	it("import & export", () => {
		const scopeCreep = scope({
			hasCrept: "true",
		});

		const types = scope({
			...threeSixtyNoScope.import("three", "no"),
			...scopeCreep.export(),
			public: "hasCrept|three|no|private",
			"#private": "string.uuid",
		}).export();

		expect(Object.keys(types)).toEqual(["hasCrept", "public"]);

		expect(types.public.json).toEqual(type("true|3|'no'|string.uuid").json);

		// have to snapshot the module since TypeScript treats it as bivariant
		void types;
	});
});

it("docs example", () => {
	const shapeScope = scope({
		// aliases with a "#" prefix are treated as private
		"#baseShapeProps": {
			perimeter: "number",
			area: "number",
		},
		ellipse: {
			// when referencing a private alias, the "#" should not be included
			"...": "baseShapeProps",
			radii: ["number", "number"],
		},
		rectangle: {
			"...": "baseShapeProps",
			width: "number",
			height: "number",
		},
	});

	// private aliases can be referenced from any scoped definition,
	// even outside the original scope
	const partialShape = shapeScope.type("Partial<baseShapeProps>");

	const _assert3: Eq<
		typeof partialShape.t,
		{
			perimeter?: number;
			area?: number;
		}
	> = true;
	const _assert4: Eq<typeof partialShape.$, typeof shapeScope> = true;

	expect(partialShape.expression).toBe("{ perimeter?: number, area?: number }");

	// when the scope is exported to a Module, they will not be included
	// hover to see the Scope's exports
	const shapeModule = shapeScope.export();

	expect(Object.keys(shapeModule)).toEqual(["ellipse", "rectangle"]);
	void shapeModule;
});

it("docs import example", () => {
	const utilityScope = scope({
		"withId<o extends object>": {
			"...": "o",
			id: "string",
		},
	});

	const userModule = type.module({
		// because we use `import()` here, we can reference our utilities
		// internally, but they will not be included in `userModule`.
		// if we used `export()` instead, `withId` could be accessed on `userModule`.
		...utilityScope.import(),
		payload: {
			name: "string",
			age: "number",
		},
		db: "withId<payload>",
	});

	expect(Object.keys(userModule)).toEqual(["payload", "db"]);
	void userModule;
});

it("binds destructured exports", () => {
	const types = scope({
		foo: "1",
		bar: "foo",
		baz: "bar",
	}).export("baz");

	const _assert5: Eq<
		typeof types,
		BoundModule<
			{
				baz: 1;
			},
			{
				foo: 1;
				bar: 1;
				baz: 1;
			}
		>
	> = true;

	const T = types.baz.or({
		foo: "foo",
		bar: "bar",
		baz: "baz",
	});

	const _assert6: Eq<
		typeof T,
		Type<
			| 1
			| {
					foo: 1;
					bar: 1;
					baz: 1;
			  },
			{
				foo: 1;
				bar: 1;
				baz: 1;
			}
		>
	> = true;
	expect(T.expression).toBe("1 | { foo: 1, bar: 1, baz: 1 }");
	expect(T.$.json).toEqual({
		foo: { unit: 1 },
		bar: { unit: 1 },
		baz: { unit: 1 },
	});
});

it("non-generic", () => {
	const types = scope({
		foo: "bar[]",
		"#bar": "boolean",
	}).export();
	expect(Object.keys(types)).toEqual(["foo"]);
	expect(types.foo.json).toEqual(type("boolean[]").json);
	const _assert7: Eq<
		typeof types,
		Module<{
			foo: boolean[];
		}>
	> = true;
});

it.todo("autocompletes private references");

it("errors on private reference with #", () => {
	expect(() =>
		scope({
			xdd: "#kekw",
			"#kekw": "true",
		}).export(),
	).toThrow();
});

it("errors on private reference with # in expression", () => {
	expect(() =>
		scope({
			xdd: "string|#kekw",
			"#kekw": "true",
		}).export(),
	).toThrow();
});

it("errors on public and private reference with same name", () => {
	expect(() =>
		scope({
			kekw: "1",
			"#kekw": "1",
		}).export(),
	).toThrow();
	expect(() =>
		scope({
			"#kekw": "1",
			kekw: "1",
		}).export(),
	).toThrow();
});

it("private generic", () => {
	const types = scope({
		foo: "bar<string>[]",
		"#bar<t>": ["t"],
	}).export();

	const Expected = type(["string"]).array();

	const _assert8: Eq<typeof types.foo.t, typeof Expected.t> = true;
	expect(types.foo.expression).toBe("[string][]");
	expect(types.foo.expression).toEqual(Expected.expression);
});
